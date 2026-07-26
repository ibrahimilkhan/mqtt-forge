using MQFaker.Domain.Enums;
using MQFaker.Domain.Models;

namespace MQFaker.Domain.Abstractions;

// Manages the lifecycle of the single active broker connection
public interface IMqttConnectionManager
{
    ConnectionState State { get; }
    Task ConnectAsync(BrokerConnectionSettings settings, CancellationToken ct);
    Task DisconnectAsync(CancellationToken ct);
}
