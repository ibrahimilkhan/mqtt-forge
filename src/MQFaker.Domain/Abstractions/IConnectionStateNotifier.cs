using MQFaker.Domain.Enums;

namespace MQFaker.Domain.Abstractions;

// Announces a change in connection state to the outside world. Kept separate from
// IMessageNotifier: the message stream is high frequency and carries data, while
// state is infrequent and carries a single enum.
public interface IConnectionStateNotifier
{
    Task NotifyStateChangedAsync(ConnectionState state);
}
