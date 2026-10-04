using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Services;

/// <summary>
/// The brokers this console reached, whether or not anybody kept them. Nothing is cached: the
/// file holds eight short records and is read when a console loads, not on the message path.
/// </summary>
public sealed class RecentBrokerService
{
    private readonly IRecentBrokerStore _store;
    private readonly TimeProvider _clock;

    // The clock is optional and defaults to the system one, the way every other service here
    // takes it: TimeProvider is deliberately not registered in the container, so a test hands one
    // to the object it is testing rather than swapping it under everything at once.
    public RecentBrokerService(IRecentBrokerStore store, TimeProvider? clock = null)
    {
        _store = store;
        _clock = clock ?? TimeProvider.System;
    }

    public Task<IReadOnlyList<RecentBroker>> GetAsync(CancellationToken ct) => _store.ListAsync(ct);

    /// <summary>Notes a connection the broker accepted.</summary>
    public Task RecordAsync(BrokerConnectionSettings settings, CancellationToken ct) =>
        _store.RecordAsync(settings, _clock.GetUtcNow(), ct);

    public Task<bool> ForgetAsync(string id, CancellationToken ct) => _store.ForgetAsync(id, ct);
}
