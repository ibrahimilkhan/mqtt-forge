using Microsoft.Extensions.Logging;
using MQFaker.Domain.Abstractions;
using MQFaker.Domain.Enums;
using MQFaker.Domain.Exceptions;
using MQFaker.Domain.Models;

namespace MQFaker.Application.Services;

public sealed class ConnectionService
{
    private readonly IMqttConnectionManager _manager;
    private readonly IConnectionSettingsStore _store;
    private readonly ILogger<ConnectionService> _logger;

    // Tracks live-connection settings to detect a repeat connect
    private BrokerConnectionSettings? _connectedSettings;

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

    public BrokerFailure? CurrentFailure => _manager.Failure;

    // A failed settings save is logged but doesn't fail an otherwise-successful connect
    public async Task<bool> ConnectAsync(BrokerConnectionSettings settings, CancellationToken ct)
    {
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

    public Task DisconnectAsync(CancellationToken ct) => _manager.DisconnectAsync(ct);

    public Task<BrokerConnectionSettings?> GetSavedSettingsAsync(CancellationToken ct) =>
        _store.LoadAsync(ct);
}
