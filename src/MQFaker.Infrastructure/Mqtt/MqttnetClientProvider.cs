using MQTTnet;

namespace MQFaker.Infrastructure.Mqtt;

// Bağlantı yöneticisi ve publisher'ın paylaştığı tek MQTTnet client örneğini tutor.
// Gate, aynı client üzerindeki bağlantı durumu değişikliklerini serileştirir.
public sealed class MqttnetClientProvider : IDisposable
{
    public IMqttClient Client { get; } = new MqttClientFactory().CreateMqttClient();

    public SemaphoreSlim Gate { get; } = new(1, 1);

    public void Dispose()
    {
        Client.Dispose();
        Gate.Dispose();
    }
}
