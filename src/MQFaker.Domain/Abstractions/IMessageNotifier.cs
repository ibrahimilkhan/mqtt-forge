using MQFaker.Domain.Models;

namespace MQFaker.Domain.Abstractions;

// Broker'dan gelen mesajı dış dünyaya (panele) haber verir.
// Domain'in teslimat teknolojisini (SignalR) bilmemesi için soyutlandı.
public interface IMessageNotifier
{
    Task NotifyMessageReceivedAsync(MqttMessage message);
}
