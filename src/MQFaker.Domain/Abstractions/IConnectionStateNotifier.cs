using MQFaker.Domain.Enums;
using MQFaker.Domain.Models;

namespace MQFaker.Domain.Abstractions;

// Separate from IMessageNotifier: state is low-frequency, unlike the message stream
public interface IConnectionStateNotifier
{
    // The failure rides along with the state: a Faulted with no explanation is what this fixes
    Task NotifyStateChangedAsync(ConnectionState state, BrokerFailure? failure);
}
