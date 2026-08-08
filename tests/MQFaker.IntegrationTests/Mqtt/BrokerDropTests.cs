using MQFaker.Domain.Abstractions;
using MQFaker.Domain.Enums;
using MQFaker.Domain.Models;
using MQFaker.Infrastructure.Mqtt;
using MQFaker.IntegrationTests.Support;
using MQTTnet;
using NSubstitute;
using Xunit;

namespace MQFaker.IntegrationTests.Mqtt;

// Broker, not the app, ends the session; a same-client-id impostor makes a real broker do that
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

        // Broker closes the older session on a same-client-id reconnect; victim learns via its own DisconnectedAsync
        using var impostor = new MqttClientFactory().CreateMqttClient();
        await impostor.ConnectAsync(new MqttClientOptionsBuilder()
            .WithTcpServer(_broker.Host, _broker.Port).WithClientId("drop-victim").Build());

        // Waits on the failure, not the state: State flips the moment the socket does, while the
        // reason arrives with MQTTnet's disconnect event a moment later. Polling the state lets
        // the assertions below run in the gap between the two.
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (manager.Failure is null && DateTime.UtcNow < deadline)
            await Task.Delay(50);

        Assert.Equal(ConnectionState.Faulted, manager.State);
        // What a real broker reports for a takeover, and what the console turns into a sentence
        Assert.Equal(
            new BrokerFailure(BrokerFailureReason.SessionTakenOver, _broker.Host, _broker.Port, "drop-victim", UseTls: false),
            manager.Failure);
        await notifier.Received(1).NotifyStateChangedAsync(
            ConnectionState.Faulted,
            Arg.Is<BrokerFailure>(f => f!.Reason == BrokerFailureReason.SessionTakenOver));
    }
}
