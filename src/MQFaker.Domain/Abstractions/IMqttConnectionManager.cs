using MQFaker.Domain.Enums;
using MQFaker.Domain.Models;

namespace MQFaker.Domain.Abstractions;

// Tek aktif broker bağlantısının yaşam döngüsünü yönetir
public interface IMqttConnectionManager
{
    ConnectionState State { get; }
    Task ConnectAsync(BrokerConnectionSettings settings, CancellationToken ct);
    Task DisconnectAsync(CancellationToken ct);
}
