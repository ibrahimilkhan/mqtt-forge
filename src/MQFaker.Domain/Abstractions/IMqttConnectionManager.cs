using MQFaker.Domain.Enums;
using MQFaker.Domain.Models;

namespace MQFaker.Domain.Abstractions;

// Manages the single active broker connection's lifecycle
public interface IMqttConnectionManager
{
    ConnectionState State { get; }
    Task ConnectAsync(BrokerConnectionSettings settings, CancellationToken ct);
    Task DisconnectAsync(CancellationToken ct);
}
