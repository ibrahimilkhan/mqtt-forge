using MQTTnet;

namespace MQFaker.Infrastructure.Mqtt;

// Holds the single MQTTnet client instance shared by the connection manager and publisher.
// Gate serializes connection state changes on that same client.
public sealed class MqttnetClientProvider : IDisposable
{
    public MqttnetClientProvider() : this(new MqttClientFactory().CreateMqttClient()) { }

    // Lets tests supply a substitute client; the host always resolves the parameterless one.
    public MqttnetClientProvider(IMqttClient client) => Client = client;

    public IMqttClient Client { get; }

    public SemaphoreSlim Gate { get; } = new(1, 1);

    public void Dispose()
    {
        Client.Dispose();
        Gate.Dispose();
    }
}
