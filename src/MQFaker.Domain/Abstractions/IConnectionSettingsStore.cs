using MQFaker.Domain.Models;

namespace MQFaker.Domain.Abstractions;

// Persists last connection settings across restarts
public interface IConnectionSettingsStore
{
    Task<BrokerConnectionSettings?> LoadAsync(CancellationToken ct);
    Task SaveAsync(BrokerConnectionSettings settings, CancellationToken ct);
}
