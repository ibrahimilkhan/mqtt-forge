using Microsoft.Extensions.Logging;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Services;

public sealed class ConnectionService
{
    private readonly IMqttConnectionManager _manager;
    private readonly IConnectionSettingsStore _store;
    private readonly ILogger<ConnectionService> _logger;

    // Tracks live-connection settings to detect a repeat connect
    private BrokerConnectionSettings? _connectedSettings;

    // How many times a person has pressed Connect, counted so that the supervisor can tell a dial
    // it did not make from one it did. The supervisor's own dials do not count; see ConnectAsync.
    private int _readerDials;

    // Serialises the two things that can happen to an in-flight attempt's source — being
    // cancelled by another request, and being disposed by the attempt itself. Cancelling a
    // disposed source throws, so the field has to be cleared and disposed as one step.
    private readonly Lock _attemptLock = new();

    /// <summary>One dial at a time, whoever asked for it.</summary>
    // There is one link, so there is one dial. Two consoles pressing Connect in the same second —
    // the desktop window and the phone the QR code opened — sent two CONNECTs at one broker, and
    // the second tore down the link the first had just made: the tree replayed twice, the
    // subscriptions of whichever lost the race were gone, and the lamp went green, amber, green.
    // The gate makes the second wait for the first to finish rather than run through it.
    private readonly SemaphoreSlim _dialGate = new(1, 1);

    // The attempt currently running, or null when nothing is in flight
    private CancellationTokenSource? _attempt;

    public ConnectionService(IMqttConnectionManager manager, IConnectionSettingsStore store,
        ILogger<ConnectionService> logger)
    {
        _manager = manager;
        _store = store;
        _logger = logger;
    }

    public ConnectionState CurrentState => _manager.State;

    /// <summary>How many dials a person has made so far, as opposed to the supervisor.</summary>
    // A counter rather than a flag, so a reader who reads it once a second can tell "another one
    // since I last looked" from "the same one I already answered". What the supervisor does with
    // it: a reader's dial supersedes whatever link was standing, so a fault that follows one is
    // the reader's own failed Connect — the form's business, with a sentence under it — and not
    // an outage of the broker they just left, which a ladder would otherwise dial back.
    public int ReaderDials => Volatile.Read(ref _readerDials);

    /// <summary>Where the reader's latest dial was aimed, as host:port. Null until they have dialled.</summary>
    // With the count above, the whole of what the supervisor asks about a reader's dial: was there
    // one, and was it at the broker that is down. A dial at that broker is a hurry-up and the
    // ladder keeps its place; a dial anywhere else is the reader leaving, and the ladder stands
    // down until a link is seen up.
    public string? LastReaderEndpoint => Volatile.Read(ref _lastReaderEndpoint);

    private string? _lastReaderEndpoint;

    public BrokerFailure? CurrentFailure => _manager.Failure;

    public BrokerLink? CurrentLink => _manager.Link;

    // A failed settings save is logged but doesn't fail an otherwise-successful connect
    public async Task<bool> ConnectAsync(
        BrokerConnectionSettings settings, CancellationToken ct, ConnectOrigin origin = ConnectOrigin.Reader)
    {
        settings = await WithKeptSecretsAsync(settings, ct);

        if (origin == ConnectOrigin.Reader)
        {
            Volatile.Write(ref _lastReaderEndpoint, $"{settings.Host}:{settings.Port}");
            Interlocked.Increment(ref _readerDials);
        }

        if (_manager.State == ConnectionState.Connected && settings == _connectedSettings)
        {
            _logger.LogInformation("Connect skipped, already connected with the same settings");
            return true;
        }

        // Ours, not the caller's: an abort has to reach the attempt from a different request,
        // which has no hold on this one's token.
        var attempt = CancellationTokenSource.CreateLinkedTokenSource(ct);

        CancellationTokenSource? standing;
        lock (_attemptLock)
        {
            standing = _attempt;
            _attempt = attempt;
        }

        // A person dialling supersedes whatever was in flight — another console's Connect, or the
        // supervisor's redial of a broker they are walking away from. Waiting behind a 20-second
        // redial for a broker they no longer want is the console ignoring them; and the supervisor
        // is the one caller that must never do this, because its whole job is to give way.
        if (origin == ConnectOrigin.Reader) standing?.Cancel();

        await _dialGate.WaitAsync(ct);

        try
        {
            await _manager.ConnectAsync(settings, attempt.Token);
        }
        // Our token down but the caller's still up means someone pressed abort. The other way
        // round the browser simply left, and the failure that actually happened is the honest
        // thing to report — the manager rethrows it in whatever shape MQTTnet gave it.
        catch (Exception ex) when (attempt.IsCancellationRequested && !ct.IsCancellationRequested)
        {
            throw new ConnectAttemptAbortedException(
                $"The attempt to connect to {settings.Host}:{settings.Port} was cancelled.", ex);
        }
        finally
        {
            _dialGate.Release();

            lock (_attemptLock)
            {
                // Only if it is still ours. A dial that superseded this one has already written
                // itself here, and clearing the field would leave that one unabortable.
                if (ReferenceEquals(_attempt, attempt)) _attempt = null;
                attempt.Dispose();
            }
        }

        _connectedSettings = settings;

        try
        {
            await _store.SaveAsync(settings, ct);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning(ex, "Connected, but failed to save connection settings");
        }

        return false;
    }

    // Calls off an attempt still in flight. Nothing in flight is not an error: whoever asked
    // wanted the attempt stopped, and it already is.
    /// <summary>The passwords the console cannot send back, taken from the saved settings.</summary>
    // The API never returns a password, so the boxes come up empty every time the panel is
    // filled from what was saved — and a reader who pressed Disconnect and Connect again was
    // told their password was wrong about a password they had never typed. The same idiom the
    // alert editor already uses for webhook headers: leave it empty and the stored value is kept.
    //
    // Only for the same broker and the same user. A username is what makes it the same identity,
    // so a reader who clears the username as well is connecting anonymously and is sent nothing;
    // and a different host, port or user is a different login, whose password is not this one.
    private async Task<BrokerConnectionSettings> WithKeptSecretsAsync(
        BrokerConnectionSettings settings, CancellationToken ct)
    {
        var wantsPassword = !string.IsNullOrEmpty(settings.Username)
            && string.IsNullOrEmpty(settings.Password);

        var wantsCertificatePassword = !string.IsNullOrEmpty(settings.Tls?.ClientCertificatePath)
            && string.IsNullOrEmpty(settings.Tls?.ClientCertificatePassword);

        if (!wantsPassword && !wantsCertificatePassword) return settings;

        BrokerConnectionSettings? saved;

        try
        {
            saved = await _store.LoadAsync(ct);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Unreadable settings are not a reason to refuse a connection the reader asked for.
            _logger.LogWarning(ex, "Could not read the saved settings to reuse a stored password");
            return settings;
        }

        if (saved is null) return settings;

        var sameBroker = saved.Host == settings.Host && saved.Port == settings.Port;

        if (wantsPassword
            && sameBroker
            && saved.Username == settings.Username
            && !string.IsNullOrEmpty(saved.Password))
        {
            settings = settings with { Password = saved.Password };
        }

        // The certificate's password answers to the certificate rather than to the user: the same
        // file opened with the same phrase, whoever is logging in.
        if (wantsCertificatePassword
            && sameBroker
            && saved.Tls?.ClientCertificatePath == settings.Tls?.ClientCertificatePath
            && !string.IsNullOrEmpty(saved.Tls?.ClientCertificatePassword))
        {
            settings = settings with
            {
                Tls = settings.TlsSettings with { ClientCertificatePassword = saved.Tls!.ClientCertificatePassword },
            };
        }

        return settings;
    }

    public void CancelAttempt()
    {
        lock (_attemptLock) _attempt?.Cancel();
    }

    /// <summary>Hangs up — and calls off any dial still in flight, whoever started it.</summary>
    // The abort first, because of what happens without it. The supervisor decides to redial off
    // a poll, and its dial then waits on the manager's gate; a reader who presses Disconnect in
    // the same second gets the gate first, hangs up, and the supervisor's dial goes through
    // straight after — a link nobody asked for, a second after somebody asked for none. Measured
    // as "sometimes it reconnects after I disconnect by hand". Cancelling the registered attempt
    // makes the dial fail on the gate instead, and the next poll finds Disconnected and rests.
    public Task DisconnectAsync(CancellationToken ct)
    {
        CancelAttempt();
        return _manager.DisconnectAsync(ct);
    }

    public Task<BrokerConnectionSettings?> GetSavedSettingsAsync(CancellationToken ct) =>
        _store.LoadAsync(ct);
}
