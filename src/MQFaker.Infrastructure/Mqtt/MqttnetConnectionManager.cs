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

    private readonly IMqttClient _client;
    private readonly SemaphoreSlim _gate;
    private readonly IConnectionStateNotifier _notifier;
    private readonly TimeSpan _connectTimeout;

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

    // Last state announced, to avoid duplicate notifications
    private int _announced = (int)ConnectionState.Disconnected;

    public MqttnetConnectionManager(
        MqttnetClientProvider provider, IConnectionStateNotifier notifier, TimeSpan? connectTimeout = null)
    {
        _client = provider.Client;
        _gate = provider.Gate;
        _notifier = notifier;
        _connectTimeout = connectTimeout ?? DefaultConnectTimeout;

        _client.DisconnectedAsync += OnDisconnectedAsync;
    }

    public ConnectionState State =>
        _client.IsConnected ? ConnectionState.Connected : _offlineState;

    public BrokerFailure? Failure =>
        _client.IsConnected || _failureReason is not { } reason || _attempted is not { } at
            ? null
            : new BrokerFailure(reason, at.Host, at.Port, at.ClientId, at.UseTls);

    // Single-active-connection rule: disconnect any existing link before reconnecting
    public async Task ConnectAsync(BrokerConnectionSettings settings, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            _offlineState = ConnectionState.Connecting;
            _failureReason = null;
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
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                // Caller cancelled, not a failure
                _offlineState = ConnectionState.Disconnected;
                await AnnounceAsync();
                throw;
            }
            catch (OperationCanceledException)
            {
                // Nobody asked to stop, so this is our deadline — or MQTTnet turning an aborted
                // socket into a cancellation, which is a dead attempt either way.
                _offlineState = ConnectionState.Faulted;
                _failureReason = BrokerFailureReason.Timeout;
                await AnnounceAsync();
                throw new BrokerUnreachableException(
                    BrokerFailureReason.Timeout,
                    $"The broker at {settings.Host}:{settings.Port} did not answer within "
                    + $"{_connectTimeout.TotalSeconds:0} seconds.");
            }
            catch (Exception ex)
            {
                _offlineState = ConnectionState.Faulted;
                _failureReason = Explain(ex, settings);
                await AnnounceAsync();
                throw new BrokerUnreachableException(
                    _failureReason.Value,
                    $"Could not connect to broker ({settings.Host}:{settings.Port}): {ex.Message}", ex);
            }

            // A refusing CONNACK comes back as a result, not an exception; unread, it would
            // tell the caller a connection it never got was made.
            var refused = result.ResultCode != MqttClientConnectResultCode.Success;

            // Post-connect, offline now means the link died, not a deliberate close
            // (also covers the broker dropping the session the instant it opens)
            _offlineState = ConnectionState.Faulted;
            _failureReason = refused
                ? BrokerFailureClassifier.Classify(result.ResultCode, HasCredentials(settings))
                : null;
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
        var state = State;
        if (Interlocked.Exchange(ref _announced, (int)state) == (int)state) return Task.CompletedTask;

        return _notifier.NotifyStateChangedAsync(state, Failure);
    }

    private MqttClientOptions BuildOptions(BrokerConnectionSettings settings)
    {
        var builder = new MqttClientOptionsBuilder()
            .WithTcpServer(settings.Host, settings.Port)
            .WithClientId(settings.ClientId);

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
