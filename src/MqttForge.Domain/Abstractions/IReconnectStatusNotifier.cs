using MqttForge.Domain.Models;

namespace MqttForge.Domain.Abstractions;

// Separate from IConnectionStateNotifier for the reason ReconnectStatus is separate from
// ConnectionState: one describes the link, the other describes the work being done on it, and a
// console reading a countdown must not have to re-read the link to do it.
public interface IReconnectStatusNotifier
{
    Task NotifyReconnectStatusChangedAsync(ReconnectStatus status);
}
