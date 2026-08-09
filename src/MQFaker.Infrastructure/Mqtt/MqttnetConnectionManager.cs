using MQFaker.Domain.Abstractions;
using MQFaker.Domain.Enums;
using MQFaker.Domain.Exceptions;
using MQFaker.Domain.Models;
using MQTTnet;

namespace MQFaker.Infrastructure.Mqtt;

public sealed class MqttnetConnectionManager : IMqttConnectionManager
{
    // Long enough for a slow broker over a slow link, short enough that a black-holed host
    // reports back instead of hanging on the OS TCP timeout (~75s on macOS, ~130s on Linux).
    private static readonly TimeSpan DefaultConnectTimeout = TimeSpan.FromSeconds(20);

    // MQTTnet defaults to pinging every 15 seconds and calls the link dead when a PINGRESP is
    // late. On a loaded public broker — with a '#' subscription filling the read loop — that is
    // no margin at all, and a working connection drops reporting "didn't respond in time".
    // A minute still notices a black-holed link quickly enough for a test console, and a socket
    // that actually breaks is reported immediately either way; this only covers silent stalls.
    public static readonly TimeSpan KeepAlive = TimeSpan.FromSeconds(60);

    private readonly IMqttClient _client;
    private readonly SemaphoreSlim _gate;
    private readonly IConnectionStateNotifier _notifier;
    private readonly TimeSpan _connectTimeout;
    private readonly TimeProvider _time;

    // Watches the TLS handshake, because the exception that escapes it has already forgotten
    // which rule the certificate broke. Attempts are serialised by the gate, so one is enough.
    private readonly TlsCertificateInspector _tls = new();

    // Reason we're offline; ignored while client reports connected, avoiding disconnect-event races
    private ConnectionState _offlineState = ConnectionState.Disconnected;

    // Why that offline state is a fault, when we know; same races, so gated the same way
    private BrokerFailureReason? _failureReason;

    // Which broker the fault is about. Kept for the whole life of a link, not just the attempt,
    // so a drop can name the endpoint it was connected to.
    private BrokerConnectionSettings? _attempted;

    // The link that is up. Read through the IsConnected gate, same as the failure, so a dead
    // link cannot describe itself as a live one.
    private BrokerLink? _link;

    // Last payload announced, to avoid duplicate notifications
    private string _announced = $"{ConnectionState.Disconnected}/";

    public MqttnetConnectionManager(
        MqttnetClientProvider provider, IConnectionStateNotifier notifier,
        TimeSpan? connectTimeout = null, TimeProvider? timeProvider = null)
    {
        _client = provider.Client;
        _gate = provider.Gate;
        _notifier = notifier;
        _connectTimeout = connectTimeout ?? DefaultConnectTimeout;
        _time = timeProvider ?? TimeProvider.System;

        _client.DisconnectedAsync += OnDisconnectedAsync;
    }

    public ConnectionState State =>
        _client.IsConnected ? ConnectionState.Connected : _offlineState;

    public BrokerFailure? Failure => _client.IsConnected ? null : Describe();

    public BrokerLink? Link => _client.IsConnected ? _link : null;

    // Single-active-connection rule: disconnect any existing link before reconnecting
    public async Task ConnectAsync(BrokerConnectionSettings settings, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            _offlineState = ConnectionState.Connecting;
            _failureReason = null;
            _link = null;
            _attempted = settings;
            _tls.Reset();
            MqttClientConnectResult result;

            // MqttClientOptions.Timeout only applies when the caller passes an uncancellable
            // token, and ASP.NET always passes a cancellable one, so the deadline has to be ours.
            using var attempt = CancellationTokenSource.CreateLinkedTokenSource(ct);
            attempt.CancelAfter(_connectTimeout);

            try
            {
                if (_client.IsConnected)
                    await _client.DisconnectAsync(cancellationToken: attempt.Token);

                // Announce only after the old link is down
                await AnnounceAsync();

                result = await _client.ConnectAsync(BuildOptions(settings), attempt.Token);
            }
            catch (Exception) when (ct.IsCancellationRequested)
            {
                // Caller went away. Whatever shape the abandoned attempt came back in, nothing
                // here is worth reporting as a broker failure.
                _offlineState = ConnectionState.Disconnected;
                await AnnounceAsync();
                throw;
            }
            catch (Exception ex) when (attempt.IsCancellationRequested || ex is OperationCanceledException)
            {
                // Our deadline. Its shape is not to be trusted: MQTTnet swallows a cancelled read
                // and reports it as a closed connection, which is indistinguishable from a peer
                // that hung up — measured against a port that accepts TCP and then says nothing.
                // Our own token is the only honest witness. The bare OperationCanceledException
                // covers the TCP phase, where MQTTnet does surface a cancellation, and an aborted
                // socket, which it converts into one.
                _failureReason = BrokerFailureReason.Timeout;
                _offlineState = ConnectionState.Faulted;
                await AnnounceAsync();
                throw new BrokerUnreachableException(
                    BrokerFailureReason.Timeout,
                    $"The broker at {settings.Host}:{settings.Port} did not answer within "
                    + $"{_connectTimeout.TotalSeconds:0} seconds.", ex);
            }
            catch (Exception ex)
            {
                _failureReason = Explain(ex, settings);
                _offlineState = ConnectionState.Faulted;
                await AnnounceAsync();
                throw new BrokerUnreachableException(
                    _failureReason.Value,
                    $"Could not connect to broker ({settings.Host}:{settings.Port}): {ex.Message}", ex);
            }

            // A refusing CONNACK comes back as a result, not an exception; unread, it would
            // tell the caller a connection it never got was made.
            var refused = result.ResultCode != MqttClientConnectResultCode.Success;

            // Reason first, state second. MQTTnet dispatches its disconnect event from the thread
            // pool, so a handler landing between these two writes would see a fault with nothing
            // to say — and latch that. Written this way it sees a state that is not yet a fault.
            _failureReason = refused
                ? BrokerFailureClassifier.Classify(result.ResultCode, HasCredentials(settings))
                : null;

            // Only where the broker accepted; a refusal leaves no link to describe.
            _link = refused ? null : LinkTo(settings, result);

            // Post-connect, offline now means the link died, not a deliberate close
            // (also covers the broker dropping the session the instant it opens)
            _offlineState = ConnectionState.Faulted;
            await AnnounceAsync();

            if (refused)
                throw new BrokerUnreachableException(
                    _failureReason!.Value,
                    $"The broker at {settings.Host}:{settings.Port} refused the connection ({result.ResultCode}).");
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task DisconnectAsync(CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            // Set before the call: socket closes even if sending DISCONNECT fails
            _offlineState = ConnectionState.Disconnected;
            _failureReason = null;
            await _client.DisconnectAsync(cancellationToken: ct);
        }
        finally
        {
            _gate.Release();
            await AnnounceAsync();
        }
    }

    // Fire-and-forget MQTTnet event; State already reflects whether this was a fault
    private Task OnDisconnectedAsync(MqttClientDisconnectedEventArgs e)
    {
        // MQTTnet raises this on the connect-failure path too, from a background task that
        // lands after the attempt has already worked out why it failed — and the reason code
        // it carries there is a leftover, not an answer. Only a link that was genuinely up
        // has a drop to explain, which is exactly what ClientWasConnected says.
        if (e.ClientWasConnected && _offlineState == ConnectionState.Faulted)
            _failureReason = BrokerFailureClassifier.Classify(e);

        return AnnounceAsync();
    }

    // The classifier can only say "the certificate was refused"; the inspector saw why.
    private BrokerFailureReason Explain(Exception exception, BrokerConnectionSettings settings)
    {
        var reason = BrokerFailureClassifier.Classify(exception, settings.UseTls);

        return reason == BrokerFailureReason.TlsFailed ? _tls.Problem ?? reason : reason;
    }

    private static bool HasCredentials(BrokerConnectionSettings settings) =>
        !string.IsNullOrEmpty(settings.Username);

    private Task AnnounceAsync()
    {
        // One read of the client's own state, so the three parts of the payload cannot disagree
        // with each other when a disconnect lands between them.
        var connected = _client.IsConnected;
        var state = connected ? ConnectionState.Connected : _offlineState;
        var failure = connected ? null : Describe();
        var link = connected ? _link : null;

        // Keyed on the whole payload, not just the state: a Faulted whose reason was worked out
        // after a first, reasonless announcement would otherwise never reach the console.
        var key = $"{state}/{failure?.Reason}";
        if (Interlocked.Exchange(ref _announced, key) == key) return Task.CompletedTask;

        return _notifier.NotifyStateChangedAsync(state, failure, link);
    }

    private BrokerFailure? Describe() =>
        _failureReason is { } reason && _attempted is { } at
            ? new BrokerFailure(reason, at.Host, at.Port, at.ClientId, at.UseTls)
            : null;

    private BrokerLink LinkTo(BrokerConnectionSettings settings, MqttClientConnectResult result) =>
        new(settings.Host, settings.Port, settings.ClientId, settings.Username, settings.UseTls,
            _time.GetUtcNow(),
            result.IsSessionPresent,
            // MQTT 5 lets the broker name the client itself. An echo of the id we asked for
            // tells the user nothing, so only a different one is worth a line.
            result.AssignedClientIdentifier is { Length: > 0 } assigned && assigned != settings.ClientId
                ? assigned
                : null,
            // Zero is MQTTnet for "the broker imposed none", not a keep-alive of no seconds.
            result.ServerKeepAlive == 0 ? null : (ushort?)result.ServerKeepAlive);

    private MqttClientOptions BuildOptions(BrokerConnectionSettings settings)
    {
        var builder = new MqttClientOptionsBuilder()
            .WithTcpServer(settings.Host, settings.Port)
            .WithClientId(settings.ClientId)
            .WithKeepAlivePeriod(KeepAlive);

        if (HasCredentials(settings))
            builder = builder.WithCredentials(settings.Username, settings.Password);

        if (settings.UseTls)
            builder = builder.WithTlsOptions(o => o
                .UseTls()
                // Returns the same verdict MQTTnet's own default gives — it is here to see the
                // reason, which is gone by the time the exception surfaces, not to change it.
                .WithCertificateValidationHandler(e =>
                    _tls.Validate(e.SslPolicyErrors, e.Chain?.ChainStatus ?? [])));

        return builder.Build();
    }
}
