using MQFaker.Domain.Models;

namespace MQFaker.Domain.Abstractions;

// Persists the last connection settings locally; restored on application start
public interface IConnectionSettingsStore
{
    Task<BrokerConnectionSettings?> LoadAsync(CancellationToken ct);
    Task SaveAsync(BrokerConnectionSettings settings, CancellationToken ct);
}
