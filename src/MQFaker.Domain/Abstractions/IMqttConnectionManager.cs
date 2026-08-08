using MQFaker.Domain.Enums;
using MQFaker.Domain.Models;

namespace MQFaker.Domain.Abstractions;

// Manages the single active broker connection's lifecycle
public interface IMqttConnectionManager
{
    ConnectionState State { get; }

    // Why the link is down; null whenever there is nothing to explain
    BrokerFailureReason? FailureReason { get; }
    Task ConnectAsync(BrokerConnectionSettings settings, CancellationToken ct);
    Task DisconnectAsync(CancellationToken ct);
}
