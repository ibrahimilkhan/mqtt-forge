using MQTTnet;

namespace MQFaker.Infrastructure.Mqtt;

// Bağlantı yöneticisi ve publisher'ın paylaştığı tek MQTTnet client örneğini tutar
public sealed class MqttnetClientProvider : IDisposable
{
    public IMqttClient Client { get; } = new MqttClientFactory().CreateMqttClient();

    public void Dispose() => Client.Dispose();
}
