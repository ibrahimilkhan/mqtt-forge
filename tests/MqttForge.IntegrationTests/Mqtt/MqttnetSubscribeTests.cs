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

    /// <summary>
    /// Two filters that overlap, one message, one delivery.
    /// </summary>
    // The broker's part of this is not a bug and cannot be argued with: a client with two
    // subscriptions matching a topic is sent the message twice, because each subscription is its
    // own standing order. What was a bug is asking twice — 'listen to every topic' is on by
    // default and every filter chip and every alert rule adds a narrower filter under it, so the
    // ordinary console doubled the counts, the plots and the rates for exactly the part of the
    // tree somebody had named.
    //
    // Against a real broker rather than a substitute, because what is being asserted is what
    // mosquitto does with the packets, not what this class thinks it sent.
    [Fact]
    public async Task A_filter_under_a_wider_one_is_delivered_once()
    {
        var arrived = new List<MqttMessage>();
        var notifier = Substitute.For<IMessageNotifier>();
        notifier.NotifyMessageReceivedAsync(Arg.Do<MqttMessage>(m => { lock (arrived) arrived.Add(m); }))
            .Returns(Task.CompletedTask);

        using var provider = new MqttnetClientProvider();
        var manager = new MqttnetConnectionManager(provider, Substitute.For<IConnectionStateNotifier>());
        var subscriber = new MqttnetSubscriber(provider, notifier);

        await manager.ConnectAsync(Settings("overlap-test"), CancellationToken.None);
        await subscriber.SubscribeAsync([new SubscriptionRequest("#", 0)], CancellationToken.None);
        await subscriber.SubscribeAsync([new SubscriptionRequest("plant/#", 0)], CancellationToken.None);

        using var external = new MqttClientFactory().CreateMqttClient();
        await external.ConnectAsync(new MqttClientOptionsBuilder()
            .WithTcpServer(_broker.Host, _broker.Port).Build());
        await external.PublishStringAsync("plant/boiler/temp", "81");

        // Long enough that a second copy would have landed. There is no event for 'nothing else
        // is coming', so the wait is the assertion.
        await Task.Delay(TimeSpan.FromSeconds(2));

        lock (arrived)
        {
            Assert.Single(arrived, m => m.Topic == "plant/boiler/temp");
            Assert.Contains("plant/#", subscriber.ActiveFilters);
        }
    }

    /// <summary>And the narrow one starts arriving on its own when the wide one goes.</summary>
    // The other half, and the half that makes the first one safe: turning off 'listen to every
    // topic' with a filter chip underneath it must not leave the chip listening to nothing.
    [Fact]
    public async Task What_a_departing_filter_was_covering_keeps_arriving()
    {
        var arrived = new List<MqttMessage>();
        var notifier = Substitute.For<IMessageNotifier>();
        notifier.NotifyMessageReceivedAsync(Arg.Do<MqttMessage>(m => { lock (arrived) arrived.Add(m); }))
            .Returns(Task.CompletedTask);

        using var provider = new MqttnetClientProvider();
        var manager = new MqttnetConnectionManager(provider, Substitute.For<IConnectionStateNotifier>());
        var subscriber = new MqttnetSubscriber(provider, notifier);

        await manager.ConnectAsync(Settings("uncover-test"), CancellationToken.None);
        await subscriber.SubscribeAsync([new SubscriptionRequest("#", 0)], CancellationToken.None);
        await subscriber.SubscribeAsync([new SubscriptionRequest("lab/#", 0)], CancellationToken.None);
        await subscriber.UnsubscribeAsync("#", CancellationToken.None);

        using var external = new MqttClientFactory().CreateMqttClient();
        await external.ConnectAsync(new MqttClientOptionsBuilder()
            .WithTcpServer(_broker.Host, _broker.Port).Build());
        await external.PublishStringAsync("lab/oven/temp", "230");
        await external.PublishStringAsync("plant/boiler/temp", "81");

        await Task.Delay(TimeSpan.FromSeconds(2));

        lock (arrived)
        {
            Assert.Single(arrived, m => m.Topic == "lab/oven/temp");
            // And nothing else: '#' is gone, so the rest of the tree is not this console's any more.
            Assert.DoesNotContain(arrived, m => m.Topic == "plant/boiler/temp");
        }
    }
}
