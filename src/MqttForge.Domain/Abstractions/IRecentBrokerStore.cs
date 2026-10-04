using MqttForge.Domain.Models;

namespace MqttForge.Domain.Abstractions;

/// <summary>Brokers this console connected to, newest first and each once, whether or not anybody kept them.</summary>
public interface IRecentBrokerStore
{
    Task<IReadOnlyList<RecentBroker>> ListAsync(CancellationToken ct);

    /// <summary>
    /// Notes a connection that worked. A broker already on the list — the same endpoint, whatever
    /// client ID or filters it was reached with — is replaced by this connection at the front
    /// rather than written twice; the oldest fall off the end.
    /// </summary>
    Task RecordAsync(BrokerConnectionSettings settings, DateTimeOffset at, CancellationToken ct);

    /// <summary>False when there was nothing under that id to forget.</summary>
    Task<bool> ForgetAsync(string id, CancellationToken ct);
}
