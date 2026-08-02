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

    public ConnectionService(IMqttConnectionManager manager, IConnectionSettingsStore store,
        ILogger<ConnectionService> logger)
    {
        _manager = manager;
        _store = store;
        _logger = logger;
    }

    public ConnectionState CurrentState => _manager.State;

    // Connects first; a failed settings write is logged but does not fail an otherwise-successful connect
    public async Task ConnectAsync(BrokerConnectionSettings settings, CancellationToken ct)
    {
        await _manager.ConnectAsync(settings, ct);

        try
        {
            await _store.SaveAsync(settings, ct);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning(ex, "Connected, but failed to save connection settings");
        }
    }

    public Task DisconnectAsync(CancellationToken ct) => _manager.DisconnectAsync(ct);

    // Returns the settings of the last successful connection; null if never saved
    public Task<BrokerConnectionSettings?> GetSavedSettingsAsync(CancellationToken ct) =>
        _store.LoadAsync(ct);
}
