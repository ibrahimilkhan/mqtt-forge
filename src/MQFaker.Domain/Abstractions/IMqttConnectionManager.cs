using MQFaker.Domain.Enums;
using MQFaker.Domain.Models;

namespace MQFaker.Domain.Abstractions;

// Manages the single active broker connection's lifecycle
public interface IMqttConnectionManager
{
    ConnectionState State { get; }

    // Why the link is down and which broker that is about; null when there is nothing to explain
    BrokerFailure? Failure { get; }
    Task ConnectAsync(BrokerConnectionSettings settings, CancellationToken ct);
    Task DisconnectAsync(CancellationToken ct);
}
