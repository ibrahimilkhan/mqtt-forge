using MQTTnet;

namespace MQFaker.Infrastructure.Mqtt;

// Shared MQTTnet client; Gate serializes connection-state changes on it
public sealed class MqttnetClientProvider : IDisposable
{
    public MqttnetClientProvider() : this(new MqttClientFactory().CreateMqttClient()) { }

    // Lets tests substitute a client; host uses the parameterless ctor
    public MqttnetClientProvider(IMqttClient client) => Client = client;

    public IMqttClient Client { get; }

    public SemaphoreSlim Gate { get; } = new(1, 1);

    public void Dispose()
    {
        Client.Dispose();
        Gate.Dispose();
    }
}
