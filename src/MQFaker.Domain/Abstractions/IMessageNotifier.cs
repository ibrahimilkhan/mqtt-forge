using MQFaker.Domain.Models;

namespace MQFaker.Domain.Abstractions;

// Announces a message received from the broker to the outside world (the console).
// Abstracted so the domain stays unaware of the delivery technology (SignalR).
public interface IMessageNotifier
{
    Task NotifyMessageReceivedAsync(MqttMessage message);
}
