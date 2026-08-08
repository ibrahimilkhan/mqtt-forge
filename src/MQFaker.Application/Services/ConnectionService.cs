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

    // Tracks live-connection settings to detect a repeat connect
    private BrokerConnectionSettings? _connectedSettings;

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

    public Task<BrokerConnectionSettings?> GetSavedSettingsAsync(CancellationToken ct) =>
        _store.LoadAsync(ct);
}
