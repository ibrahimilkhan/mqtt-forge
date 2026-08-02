using MQFaker.Domain.Enums;

namespace MQFaker.Domain.Abstractions;

// Separate from IMessageNotifier: state is low-frequency, unlike the message stream
public interface IConnectionStateNotifier
{
    Task NotifyStateChangedAsync(ConnectionState state);
}
