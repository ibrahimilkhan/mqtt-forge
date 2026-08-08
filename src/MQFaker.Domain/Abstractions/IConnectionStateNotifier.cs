using MQFaker.Domain.Enums;
using MQFaker.Domain.Models;

namespace MQFaker.Domain.Abstractions;

// Separate from IMessageNotifier: state is low-frequency, unlike the message stream
public interface IConnectionStateNotifier
{
    // Failure and link both ride with the state: the console replaces its whole picture from
    // this one payload, so anything left out of it is something the console has to forget.
    Task NotifyStateChangedAsync(ConnectionState state, BrokerFailure? failure, BrokerLink? link);
}
