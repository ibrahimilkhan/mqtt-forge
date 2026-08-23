using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;
using MQTTnet;

namespace MqttForge.Infrastructure.Mqtt;

public sealed class MqttnetConnectionManager : IMqttConnectionManager
{
    // Long enough for a slow broker over a slow link, short enough that a black-holed host
    // reports back instead of hanging on the OS TCP timeout (~75s on macOS, ~130s on Linux).
    //
    // Per version tried, not for the whole attempt. That reads as three times the wait until you
    // see which failures move the ladder on: only a broker that answers and refuses the version,
    // which is immediate. Everything slow — a black hole, an unreachable host — stops the walk
    // where it happens, so the deadline a reader actually experiences is this one.
    private static readonly TimeSpan DefaultConnectTimeout = TimeSpan.FromSeconds(20);

    // Kept here as well as on the factory so the tests and the API that already read it off this
    // class do not have to learn a new home for it.
    public static readonly TimeSpan KeepAlive = MqttClientOptionsFactory.KeepAlive;

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

            try
            {
                if (_client.IsConnected)
                    await _client.DisconnectAsync(cancellationToken: ct);
            }
            catch (Exception) when (ct.IsCancellationRequested)
            {
                // The caller went away while the old link was being closed. The socket is down
                // either way — MQTTnet closes it in a finally — so this is a disconnection, not
                // a broker fault, and there is nobody left to explain one to.
                _offlineState = ConnectionState.Disconnected;
                await AnnounceAsync();
                throw;
            }

            // Announce only after the old link is down
            await AnnounceAsync();

            await WalkVersionsAsync(settings, ct);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Tries each MQTT version the settings ask for, in order, and keeps the first one a broker
    /// accepts.
    /// </summary>
    // The whole reason Auto exists. A broker refusing a version it does not speak is not a
    // failure a reader can act on — it is a number they were never told to care about — and the
    // two ways brokers say it are not alike: MQTT 5 brokers send a CONNACK naming the problem,
    // while the v3-only ones simply close the socket, which is indistinguishable from anything
    // else that answers and hangs up. So the ladder moves on for both, and stops for everything
    // else: a wrong password, an untrusted certificate and an unreachable host all mean the same
    // thing at every version, and retrying them twice more only makes the reader wait.
    private async Task WalkVersionsAsync(BrokerConnectionSettings settings, CancellationToken ct)
    {
        var versions = MqttClientOptionsFactory.VersionsToTry(settings.ProtocolVersion);

        for (var i = 0; i < versions.Count; i++)
        {
            var last = i == versions.Count - 1;

            try
            {
                await AttemptAsync(settings, versions[i], ct);
                return;
            }
            catch (BrokerUnreachableException ex) when (!last && MovesToNextVersion(ex.Reason))
            {
                // Next rung, and the console is told nothing. It is still connecting — which is
                // what the state has said since the walk began — and a Faulted flashing past on
                // the way to a link that came up would be a lie about a connection that is
                // about to work.
            }
            catch (BrokerUnreachableException)
            {
                // The end of the walk, whether because this rung's failure is not about the
                // version or because there are no rungs left. Only now is there a fault.
                _offlineState = ConnectionState.Faulted;
                await AnnounceAsync();
                throw;
            }
        }
    }

    private static bool MovesToNextVersion(BrokerFailureReason reason) => reason is
        // The broker named the problem.
        BrokerFailureReason.ProtocolVersionUnsupported or
        // The broker closed on the CONNECT without answering, which is what mosquitto 1.x and
        // most v3-only brokers do — measured, not assumed. It also covers a port that is not a
        // broker at all, and the cost of that is one wasted round trip against a host that has
        // already answered, which is cheaper than failing to reach a broker that works.
        BrokerFailureReason.NoMqttResponse;

    // One version, one CONNECT. Everything the caller needs to know comes back as an exception
    // or as a link; the state fields are left describing whichever of the two happened.
    private async Task AttemptAsync(
        BrokerConnectionSettings settings, MqttProtocolLevel version, CancellationToken ct)
    {
        _tls.Reset();
        MqttClientConnectResult result;

        // MqttClientOptions.Timeout only applies when the caller passes an uncancellable
        // token, and ASP.NET always passes a cancellable one, so the deadline has to be ours.
        using var attempt = CancellationTokenSource.CreateLinkedTokenSource(ct);
        attempt.CancelAfter(_connectTimeout);

        try
        {
            var options = MqttClientOptionsFactory.Build(settings, version, _tls);
            result = await _client.ConnectAsync(options, attempt.Token);
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
            throw Fault(
                BrokerFailureReason.Timeout, settings,
                $"The broker at {settings.Host}:{settings.Port} did not answer within "
                + $"{_connectTimeout.TotalSeconds:0} seconds.", ex);
        }
        catch (Exception ex)
        {
            throw Fault(
                Explain(ex, settings), settings,
                $"Could not connect to broker ({settings.Endpoint}): {ex.Message}", ex);
        }

        // A refusing CONNACK comes back as a result, not an exception; unread, it would
        // tell the caller a connection it never got was made.
        if (result.ResultCode != MqttClientConnectResultCode.Success)
        {
            var reason = BrokerFailureClassifier.Classify(
                result.ResultCode, MqttClientOptionsFactory.HasCredentials(settings));

            throw Fault(
                reason, settings,
                $"The broker at {settings.Host}:{settings.Port} refused the connection ({result.ResultCode}).");
        }

        // Reason first, state second. MQTTnet dispatches its disconnect event from the thread
        // pool, so a handler landing between these two writes would see a fault with nothing
        // to say — and latch that. Written this way it sees a state that is not yet a fault.
        _failureReason = null;
        _link = LinkTo(settings, version, result);

        // Post-connect, offline now means the link died, not a deliberate close
        // (also covers the broker dropping the session the instant it opens)
        _offlineState = ConnectionState.Faulted;
        await AnnounceAsync();
    }

    // Records why this attempt failed and hands back the exception for the caller to throw, so
    // that every failure path leaves the same thing behind in the same shape.
    //
    // Deliberately does not announce, and deliberately leaves the state at Connecting. A rung
    // the ladder is about to step off is not a fault, and the console has no use for one — nor
    // has MQTTnet's own disconnect event, which fires on every failed attempt from the thread
    // pool and would otherwise find a Faulted state to broadcast. The walk announces once, when
    // it gives up.
    private BrokerUnreachableException Fault(
        BrokerFailureReason reason, BrokerConnectionSettings settings, string message,
        Exception? inner = null)
    {
        // A version that was asked for by name failed as itself. One picked off the Auto ladder
        // did not: the reader asked for "whatever works", so a failure that ends the walk is
        // about the broker, not about the rung it happened on.
        _failureReason = settings.ProtocolVersion == MqttProtocolLevel.Auto
                         && reason == BrokerFailureReason.ProtocolVersionUnsupported
            ? BrokerFailureReason.NoSupportedProtocolVersion
            : reason;

        return new BrokerUnreachableException(reason, message, inner);
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

    // The classifier can only say "the encrypted channel failed"; the inspector was inside it.
    private BrokerFailureReason Explain(Exception exception, BrokerConnectionSettings settings)
    {
        var reason = BrokerFailureClassifier.Classify(exception, settings.UseTls, settings.Transport);

        if (reason != BrokerFailureReason.TlsFailed) return reason;

        // Something was wrong with the broker's certificate, and the inspector knows which rule
        // it broke — a detail the exception threw away on its way up.
        if (_tls.Problem is { } problem) return problem;

        // Nothing was wrong with it — we did not refuse anything — and the handshake failed
        // anyway. That leaves the broker as the party that objected, and at that point in a
        // handshake what a broker objects to is our certificate: the one we sent, or the one it
        // wanted and did not get.
        //
        // Measured against a mosquitto listener with require_certificate on, .NET 10 on macOS:
        // sending nothing ends in SslException "handshake failure" with the validation callback
        // never called at all, and sending a certificate from an unknown CA in "unknown Cert
        // Authority". Neither alert name reaches a field — only that message — and Schannel
        // words both differently, so which of the two happened is read from what we sent rather
        // than from what came back. The sentences the console shows are qualified to match:
        // this is the likeliest cause of a handshake the broker ended in silence, not the only
        // one it could be.
        return settings.TlsSettings.ClientCertificatePath is { Length: > 0 }
            ? BrokerFailureReason.ClientCertificateRejected
            : BrokerFailureReason.ClientCertificateRequired;
    }

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
            ? new BrokerFailure(reason, at.Host, at.Port, at.ClientId, at.UseTls, at.Transport, at.ProtocolVersion)
            : null;

    private BrokerLink LinkTo(
        BrokerConnectionSettings settings, MqttProtocolLevel version, MqttClientConnectResult result) =>
        new(settings.Host, settings.Port, settings.ClientId, settings.Username, settings.UseTls,
            _time.GetUtcNow(),
            result.IsSessionPresent,
            // MQTT 5 lets the broker name the client itself. An echo of the id we asked for
            // tells the user nothing, so only a different one is worth a line.
            result.AssignedClientIdentifier is { Length: > 0 } assigned && assigned != settings.ClientId
                ? assigned
                : null,
            // Zero is MQTTnet for "the broker imposed none", not a keep-alive of no seconds.
            result.ServerKeepAlive == 0 ? null : (ushort?)result.ServerKeepAlive,
            settings.Transport,
            // The version that was accepted, never the one that was asked for. With Auto doing
            // the choosing they are different things, and this is the half a reader cannot see.
            version);
}
