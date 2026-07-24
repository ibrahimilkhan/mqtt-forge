using MQFaker.Domain.Models;

namespace MQFaker.Domain.Abstractions;

// Son bağlantı ayarlarını yerel olarak saklar; uygulama açılışında geri yükler
public interface IConnectionSettingsStore
{
    Task<BrokerConnectionSettings?> LoadAsync(CancellationToken ct);
    Task SaveAsync(BrokerConnectionSettings settings, CancellationToken ct);
}
