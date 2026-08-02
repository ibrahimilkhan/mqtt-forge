using MQFaker.Domain.Abstractions;
using MQFaker.Domain.Exceptions;
using MQFaker.Domain.Models;
using MQFaker.Infrastructure.Mqtt;
using MQFaker.IntegrationTests.Support;
using NSubstitute;
using Xunit;

namespace MQFaker.IntegrationTests.Mqtt;

// A topic or payload that is technically valid MQTT but far past what anyone would type by
// hand - the kind a fuzzer or a runaway publisher produces in production
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
            () => publisher.PublishAsync(new PublishRequest(topic, "x", 0, false), CancellationToken.None));
    }

    [Fact]
    public async Task Subscribe_with_a_topic_filter_over_the_protocol_limit_is_rejected_not_a_500()
    {
        using var provider = await ConnectedProviderAsync("long-topic-subscribe");
        var subscriber = new MqttnetSubscriber(provider, Substitute.For<IMessageNotifier>());
        var filter = new string('a', 70_000);

        await Assert.ThrowsAsync<MessageRejectedException>(
            () => subscriber.SubscribeAsync(new SubscriptionRequest(filter, 0), CancellationToken.None));
    }

    [Fact]
    public async Task Publish_with_a_payload_the_broker_refuses_as_too_large_is_rejected_not_a_500()
    {
        using var provider = await ConnectedProviderAsync("large-payload-publish");
        var publisher = new MqttnetPublisher(provider);
        var payload = new string('x', 5_000_000);

        await Assert.ThrowsAsync<MessageRejectedException>(
            () => publisher.PublishAsync(new PublishRequest("sensors/big", payload, 0, false), CancellationToken.None));
    }
}
