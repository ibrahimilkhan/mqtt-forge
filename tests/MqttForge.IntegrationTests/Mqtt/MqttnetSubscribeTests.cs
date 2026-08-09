using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Mqtt;
using MqttForge.IntegrationTests.Support;
using MQTTnet;
using NSubstitute;
using Xunit;

namespace MqttForge.IntegrationTests.Mqtt;

public class MqttnetSubscribeTests : IClassFixture<MosquittoFixture>
{
    private readonly MosquittoFixture _broker;

    public MqttnetSubscribeTests(MosquittoFixture broker) => _broker = broker;

    private BrokerConnectionSettings Settings(string clientId) =>
        new(_broker.Host, _broker.Port, clientId, null, null, false);

    [Fact]
    public async Task Subscribed_topic_delivers_incoming_message_to_notifier()
    {
        var delivered = new TaskCompletionSource<MqttMessage>();
        var notifier = Substitute.For<IMessageNotifier>();
        notifier.NotifyMessageReceivedAsync(Arg.Do<MqttMessage>(m => delivered.TrySetResult(m)))
            .Returns(Task.CompletedTask);

        using var provider = new MqttnetClientProvider();
        var manager = new MqttnetConnectionManager(provider, Substitute.For<IConnectionStateNotifier>());
        var subscriber = new MqttnetSubscriber(provider, notifier);

        await manager.ConnectAsync(Settings("sub-test"), CancellationToken.None);
        await subscriber.SubscribeAsync([new SubscriptionRequest("sensors/#", 0)], CancellationToken.None);

        Assert.Contains("sensors/#", subscriber.ActiveFilters);

        // Have an external publisher actually send a message to the broker
        using var external = new MqttClientFactory().CreateMqttClient();
        await external.ConnectAsync(new MqttClientOptionsBuilder()
            .WithTcpServer(_broker.Host, _broker.Port).Build());
        await external.PublishStringAsync("sensors/room/temp", "21.7");

        var message = await delivered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("sensors/room/temp", message.Topic);
        Assert.Equal("21.7", message.Payload);
    }

    [Fact]
    public async Task Unsubscribe_removes_the_filter()
    {
        using var provider = new MqttnetClientProvider();
        var manager = new MqttnetConnectionManager(provider, Substitute.For<IConnectionStateNotifier>());
        var subscriber = new MqttnetSubscriber(provider, Substitute.For<IMessageNotifier>());

        await manager.ConnectAsync(Settings("unsub-test"), CancellationToken.None);
        await subscriber.SubscribeAsync([new SubscriptionRequest("a/#", 0)], CancellationToken.None);

        await subscriber.UnsubscribeAsync("a/#", CancellationToken.None);

        Assert.Empty(subscriber.ActiveFilters);
    }

    [Fact]
    public async Task Subscribe_without_connection_throws_NotConnected()
    {
        using var provider = new MqttnetClientProvider();
        var subscriber = new MqttnetSubscriber(provider, Substitute.For<IMessageNotifier>());

        await Assert.ThrowsAsync<NotConnectedException>(
            () => subscriber.SubscribeAsync([new SubscriptionRequest("a/#", 0)], CancellationToken.None));
    }

    [Fact]
    public async Task Disconnecting_clears_active_filters()
    {
        using var provider = new MqttnetClientProvider();
        var manager = new MqttnetConnectionManager(provider, Substitute.For<IConnectionStateNotifier>());
        var subscriber = new MqttnetSubscriber(provider, Substitute.For<IMessageNotifier>());

        await manager.ConnectAsync(Settings("clear-test"), CancellationToken.None);
        await subscriber.SubscribeAsync([new SubscriptionRequest("a/#", 0)], CancellationToken.None);
        Assert.NotEmpty(subscriber.ActiveFilters);

        await manager.DisconnectAsync(CancellationToken.None);

        // The disconnect event fires asynchronously; allow a short window
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (subscriber.ActiveFilters.Count > 0 && DateTime.UtcNow < deadline)
            await Task.Delay(50);

        Assert.Empty(subscriber.ActiveFilters);
    }
}
