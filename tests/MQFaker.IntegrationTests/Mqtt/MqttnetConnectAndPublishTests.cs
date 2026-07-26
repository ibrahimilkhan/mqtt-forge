using MQFaker.Domain.Enums;
using MQFaker.Domain.Models;
using MQFaker.Infrastructure.Mqtt;
using MQFaker.IntegrationTests.Support;
using MQTTnet;
using Xunit;

namespace MQFaker.IntegrationTests.Mqtt;

public class MqttnetConnectAndPublishTests : IClassFixture<MosquittoFixture>
{
    private readonly MosquittoFixture _broker;

    public MqttnetConnectAndPublishTests(MosquittoFixture broker) => _broker = broker;

    [Fact]
    public async Task Connect_then_publish_delivers_message_to_subscriber()
    {
        using var provider = new MqttnetClientProvider();
        var manager = new MqttnetConnectionManager(provider);
        var publisher = new MqttnetPublisher(provider);
        var settings = new BrokerConnectionSettings(_broker.Host, _broker.Port, "mqfaker-test", null, null, false);

        // An independent verifying subscriber, separate from production code: the test's own eye
        using var verifier = new MqttClientFactory().CreateMqttClient();
        var received = new TaskCompletionSource<string>();
        verifier.ApplicationMessageReceivedAsync += e =>
        {
            received.TrySetResult(e.ApplicationMessage.ConvertPayloadToString() ?? string.Empty);
            return Task.CompletedTask;
        };
        await verifier.ConnectAsync(new MqttClientOptionsBuilder()
            .WithTcpServer(_broker.Host, _broker.Port).Build());
        await verifier.SubscribeAsync("sensors/temp");

        await manager.ConnectAsync(settings, CancellationToken.None);
        Assert.Equal(ConnectionState.Connected, manager.State);

        await publisher.PublishAsync(new PublishRequest("sensors/temp", "23.5", 0, false), CancellationToken.None);

        var payload = await received.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("23.5", payload);

        await manager.DisconnectAsync(CancellationToken.None);
        Assert.Equal(ConnectionState.Disconnected, manager.State);
    }
}
