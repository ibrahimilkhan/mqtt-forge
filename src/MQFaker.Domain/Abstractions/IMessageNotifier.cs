using MQFaker.Domain.Models;

namespace MQFaker.Domain.Abstractions;

// Keeps the domain unaware of the delivery technology (SignalR)
public interface IMessageNotifier
{
    Task NotifyMessageReceivedAsync(MqttMessage message);
}
