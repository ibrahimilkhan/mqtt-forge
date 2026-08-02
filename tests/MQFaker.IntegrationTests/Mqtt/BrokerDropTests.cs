using MQFaker.Domain.Abstractions;
using MQFaker.Domain.Enums;
using MQFaker.Domain.Models;
using MQFaker.Infrastructure.Mqtt;
using MQFaker.IntegrationTests.Support;
using MQTTnet;
using NSubstitute;
using Xunit;

namespace MQFaker.IntegrationTests.Mqtt;

// The broker, not the app, ends the session mid-flight - a restart, an idle timeout, an
// admin kicking the client. A second client using the same client id makes a real broker
// do exactly that, without needing to actually restart the container.
public class BrokerDropTests : IClassFixture<MosquittoFixture>
{
    private readonly MosquittoFixture _broker;
    public BrokerDropTests(MosquittoFixture broker) => _broker = broker;

    [Fact]
    public async Task Connection_state_becomes_faulted_when_the_broker_drops_the_session_unexpectedly()
    {
        var notifier = Substitute.For<IConnectionStateNotifier>();
        using var provider = new MqttnetClientProvider();
        var manager = new MqttnetConnectionManager(provider, notifier);
        var settings = new BrokerConnectionSettings(_broker.Host, _broker.Port, "drop-victim", null, null, false);

        await manager.ConnectAsync(settings, CancellationToken.None);
        Assert.Equal(ConnectionState.Connected, manager.State);

        // MQTT requires the broker to close the older session when the same client id
        // reconnects; the victim finds out through its own DisconnectedAsync event.
        using var impostor = new MqttClientFactory().CreateMqttClient();
        await impostor.ConnectAsync(new MqttClientOptionsBuilder()
            .WithTcpServer(_broker.Host, _broker.Port).WithClientId("drop-victim").Build());

        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (manager.State != ConnectionState.Faulted && DateTime.UtcNow < deadline)
            await Task.Delay(50);

        Assert.Equal(ConnectionState.Faulted, manager.State);
        await notifier.Received(1).NotifyStateChangedAsync(ConnectionState.Faulted);
    }
}
