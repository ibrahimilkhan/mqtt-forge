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
        lock (_attemptLock) _attempt = attempt;

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
            lock (_attemptLock)
            {
                _attempt = null;
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
