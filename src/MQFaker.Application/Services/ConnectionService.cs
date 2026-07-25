using MQFaker.Domain.Abstractions;
using MQFaker.Domain.Enums;
using MQFaker.Domain.Models;

namespace MQFaker.Application.Services;

public sealed class ConnectionService
{
    private readonly IMqttConnectionManager _manager;
    private readonly IConnectionSettingsStore _store;

    public ConnectionService(IMqttConnectionManager manager, IConnectionSettingsStore store)
    {
        _manager = manager;
        _store = store;
    }

    public ConnectionState CurrentState => _manager.State;

    // Önce bağlanır; yalnızca bağlantı başarılıysa ayarları diske kaydeder
    public async Task ConnectAsync(BrokerConnectionSettings settings, CancellationToken ct)
    {
        await _manager.ConnectAsync(settings, ct);
        await _store.SaveAsync(settings, ct);
    }

    public Task DisconnectAsync(CancellationToken ct) => _manager.DisconnectAsync(ct);

    // En son başarılı bağlantının ayarlarını döner; hiç kaydedilmemişse null
    public Task<BrokerConnectionSettings?> GetSavedSettingsAsync(CancellationToken ct) =>
        _store.LoadAsync(ct);
}
