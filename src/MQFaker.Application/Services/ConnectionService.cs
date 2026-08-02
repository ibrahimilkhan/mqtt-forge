using Microsoft.Extensions.Logging;
using MQFaker.Domain.Abstractions;
using MQFaker.Domain.Enums;
using MQFaker.Domain.Models;

namespace MQFaker.Application.Services;

public sealed class ConnectionService
{
    private readonly IMqttConnectionManager _manager;
    private readonly IConnectionSettingsStore _store;
    private readonly ILogger<ConnectionService> _logger;

    // Settings behind the current live connection, to detect a redundant repeat
    private BrokerConnectionSettings? _connectedSettings;

    public ConnectionService(IMqttConnectionManager manager, IConnectionSettingsStore store,
        ILogger<ConnectionService> logger)
    {
        _manager = manager;
        _store = store;
        _logger = logger;
    }

    public ConnectionState CurrentState => _manager.State;

    // Returns true when the request was a no-op because it matched the live connection.
    // Connects first; a failed settings write is logged but does not fail an otherwise-successful connect
    public async Task<bool> ConnectAsync(BrokerConnectionSettings settings, CancellationToken ct)
    {
        if (_manager.State == ConnectionState.Connected && settings == _connectedSettings)
        {
            _logger.LogInformation("Connect skipped, already connected with the same settings");
            return true;
        }

        await _manager.ConnectAsync(settings, ct);
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

    public Task DisconnectAsync(CancellationToken ct) => _manager.DisconnectAsync(ct);

    // Returns the settings of the last successful connection; null if never saved
    public Task<BrokerConnectionSettings?> GetSavedSettingsAsync(CancellationToken ct) =>
        _store.LoadAsync(ct);
}
