using System.Text;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Mqtt;
using MqttForge.IntegrationTests.Support;
using NSubstitute;
using Xunit;

namespace MqttForge.IntegrationTests.Mqtt;

// Technically valid MQTT but far past hand-typed size — what a fuzzer or runaway publisher produces
public class MessageLimitsTests : IClassFixture<MosquittoFixture>
{
    private readonly MosquittoFixture _broker;
    public MessageLimitsTests(MosquittoFixture broker) => _broker = broker;

    private async Task<MqttnetClientProvider> ConnectedProviderAsync(string clientId)
    {
        var provider = new MqttnetClientProvider();
        var manager = new MqttnetConnectionManager(provider, Substitute.For<IConnectionStateNotifier>());
        await manager.ConnectAsync(
            new BrokerConnectionSettings(_broker.Host, _broker.Port, clientId, null, null, false),
            CancellationToken.None);
        return provider;
    }

    [Fact]
    public async Task Publish_with_a_topic_over_the_protocol_limit_is_rejected_not_a_500()
    {
        using var provider = await ConnectedProviderAsync("long-topic-publish");
        var publisher = new MqttnetPublisher(provider);
        var topic = new string('a', 70_000);

        await Assert.ThrowsAsync<MessageRejectedException>(
            () => publisher.PublishAsync(new PublishRequest(topic, "x"u8.ToArray(), 0, false), CancellationToken.None));
    }

    [Fact]
    public async Task Subscribe_with_a_topic_filter_over_the_protocol_limit_is_rejected_not_a_500()
    {
        using var provider = await ConnectedProviderAsync("long-topic-subscribe");
        var subscriber = new MqttnetSubscriber(provider, Substitute.For<IMessageNotifier>());
        var filter = new string('a', 70_000);

        await Assert.ThrowsAsync<MessageRejectedException>(
            () => subscriber.SubscribeAsync([new SubscriptionRequest(filter, 0)], CancellationToken.None));
    }

}

// Against a broker that declares a small maximum, so the refusal is the broker's answer rather
// than a race with it: see SmallPacketMosquittoFixture.
public class OversizedMessageTests : IClassFixture<SmallPacketMosquittoFixture>
{
    private readonly SmallPacketMosquittoFixture _broker;
    public OversizedMessageTests(SmallPacketMosquittoFixture broker) => _broker = broker;

    [Fact]
    public async Task Publish_with_a_payload_the_broker_refuses_as_too_large_is_rejected_not_a_500()
    {
        using var provider = new MqttnetClientProvider();
        var manager = new MqttnetConnectionManager(provider, Substitute.For<IConnectionStateNotifier>());
        await manager.ConnectAsync(
            new BrokerConnectionSettings(_broker.Host, _broker.Port, "large-payload-publish", null, null, false),
            CancellationToken.None);

        var publisher = new MqttnetPublisher(provider);
        var payload = new string('x', SmallPacketMosquittoFixture.MaxPacketBytes * 4);

        // QoS 1, not 0: at most once is fire-and-forget, so the call returns before the broker
        // has said anything and the refusal lands after the test is over. At least once waits
        // for an acknowledgement, and what comes back instead is the refusal.
        await Assert.ThrowsAsync<MessageRejectedException>(
            () => publisher.PublishAsync(
                new PublishRequest("sensors/big", Encoding.UTF8.GetBytes(payload), 1, false),
                CancellationToken.None));
    }
}
