using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.Domain.Abstractions;

// Manages the single active broker connection's lifecycle
public interface IMqttConnectionManager
{
    ConnectionState State { get; }

    // Why the link is down and which broker that is about; null when there is nothing to explain
    BrokerFailure? Failure { get; }

    // Which broker is up and what it said when it accepted; null when nothing is up
    BrokerLink? Link { get; }
    Task ConnectAsync(BrokerConnectionSettings settings, CancellationToken ct);
    Task DisconnectAsync(CancellationToken ct);
}
