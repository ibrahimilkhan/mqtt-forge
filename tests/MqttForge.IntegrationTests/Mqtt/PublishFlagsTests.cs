using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Mqtt;
using MqttForge.IntegrationTests.Support;
using MQTTnet;
using MQTTnet.Protocol;
using NSubstitute;
using Xunit;

namespace MqttForge.IntegrationTests.Mqtt;

/// <summary>
/// What actually goes out on the wire when the publish form's QoS and Retain are set.
///
/// Reported as 'publishing does not honour QoS and retain: I tick them and the log says qos 0 and
/// not retained'. The log was reading the broker's copy of the message back, and a delivered copy
/// carries neither of the publisher's answers: a subscription caps the QoS of every copy sent
/// under it, and a broker clears the retain bit on every copy it forwards to a subscription that
/// was already up. So the console could not settle the question about itself, and neither can a
/// test that asks the console.
///
/// These ask the broker instead, through a subscriber of the test's own that is nothing to do
/// with the production code — and, for retain, through a second subscriber that arrives after the
/// message, which is the only client MQTT ever shows a retained flag to.
/// </summary>
public class PublishFlagsTests : IClassFixture<MosquittoFixture>
{
    private readonly MosquittoFixture _broker;

    public PublishFlagsTests(MosquittoFixture broker) => _broker = broker;

    private BrokerConnectionSettings Settings(string clientId) =>
        new(_broker.Host, _broker.Port, clientId, null, null, false);

    /// <summary>The console's own publisher, connected — the thing under test and nothing else.</summary>
    private async Task<(MqttnetClientProvider provider, MqttnetPublisher publisher)> Console_(string clientId)
    {
        var provider = new MqttnetClientProvider();
        var manager = new MqttnetConnectionManager(provider, Substitute.For<IConnectionStateNotifier>());
        await manager.ConnectAsync(Settings(clientId), CancellationToken.None);

        return (provider, new MqttnetPublisher(provider));
    }

    /// <summary>
    /// A witness of the test's own, subscribed at QoS 2.
    ///
    /// The ceiling matters: delivery is at the lower of the published and the subscribed QoS, so
    /// a witness subscribed at 0 would report 0 for every publish and prove nothing.
    /// </summary>
    private async Task<(IMqttClient client, TaskCompletionSource<MqttApplicationMessage> seen)> Witness(
        string clientId,
        string topic)
    {
        var seen = new TaskCompletionSource<MqttApplicationMessage>();
        var client = new MqttClientFactory().CreateMqttClient();
        client.ApplicationMessageReceivedAsync += e =>
        {
            seen.TrySetResult(e.ApplicationMessage);
            return Task.CompletedTask;
        };

        await client.ConnectAsync(new MqttClientOptionsBuilder()
            .WithTcpServer(_broker.Host, _broker.Port)
            .WithClientId(clientId)
            .WithCleanSession()
            .Build());
        await client.SubscribeAsync(new MqttClientSubscribeOptionsBuilder()
            .WithTopicFilter(topic, MqttQualityOfServiceLevel.ExactlyOnce)
            .Build());

        return (client, seen);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    public async Task Publish_reaches_the_broker_at_the_qos_it_was_given(int qos)
    {
        var topic = $"lab/qos/{qos}";
        var (witness, seen) = await Witness($"witness-qos-{qos}", topic);
        using var _ = witness;

        var (provider, publisher) = await Console_($"console-qos-{qos}");
        using var __ = provider;

        await publisher.PublishAsync(
            new PublishRequest(topic, "23.5"u8.ToArray(), qos, Retain: false),
            CancellationToken.None);

        var delivered = await seen.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(qos, (int)delivered.QualityOfServiceLevel);
        Assert.Equal("23.5", delivered.ConvertPayloadToString());
    }

    [Fact]
    public async Task Retained_publish_is_stored_by_the_broker_and_marked_retained_for_a_new_subscriber()
    {
        const string topic = "lab/retain/stored";
        var (provider, publisher) = await Console_("console-retain");
        using var _ = provider;

        await publisher.PublishAsync(
            new PublishRequest(topic, "23.5"u8.ToArray(), Qos: 1, Retain: true),
            CancellationToken.None);

        // Subscribed after the fact, which is the only client a broker ever shows the retain flag
        // to — and the only way to prove the console asked for the message to be kept.
        var (witness, seen) = await Witness("witness-retain-after", topic);
        using var __ = witness;

        var delivered = await seen.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(delivered.Retain);
        Assert.Equal("23.5", delivered.ConvertPayloadToString());
    }

    /// <summary>
    /// The rule that made the report look true, pinned so nobody 'fixes' the console over it.
    /// </summary>
    [Fact]
    public async Task A_subscriber_already_listening_is_shown_the_same_message_with_retain_cleared()
    {
        const string topic = "lab/retain/live";
        var (witness, seen) = await Witness("witness-retain-live", topic);
        using var _ = witness;

        var (provider, publisher) = await Console_("console-retain-live");
        using var __ = provider;

        await publisher.PublishAsync(
            new PublishRequest(topic, "23.5"u8.ToArray(), Qos: 1, Retain: true),
            CancellationToken.None);

        var delivered = await seen.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.False(delivered.Retain);
    }

    /// <summary>
    /// The console's own subscriber, and what its rows are therefore able to say.
    ///
    /// Two ceilings decide it. The QoS on a row is the delivered QoS, which a subscription caps —
    /// so a console listening at 0 stamps every arrival 'QoS 0' whatever the publisher chose, and
    /// listening at 2 stamps it with the publisher's own answer. The retain flag on a row is
    /// cleared by the broker on every live forward unless the subscription asks for retain as
    /// published, which is an MQTT 5 subscription option this console now sets where the link
    /// carries it.
    ///
    /// Together they are the difference between a log that can report a QoS 2 retained publish
    /// and one that reports 'qos 0, not retained' at everybody, for ever.
    /// </summary>
    [Fact]
    public async Task The_console_reads_back_a_retained_qos2_publish_as_what_it_was()
    {
        const string topic = "lab/readback";

        var delivered = new TaskCompletionSource<MqttMessage>();
        var notifier = Substitute.For<IMessageNotifier>();
        notifier.NotifyMessageReceivedAsync(Arg.Do<MqttMessage>(m => delivered.TrySetResult(m)))
            .Returns(Task.CompletedTask);

        using var provider = new MqttnetClientProvider();
        var manager = new MqttnetConnectionManager(provider, Substitute.For<IConnectionStateNotifier>());
        var subscriber = new MqttnetSubscriber(provider, notifier);
        var publisher = new MqttnetPublisher(provider);

        await manager.ConnectAsync(Settings("console-readback"), CancellationToken.None);
        await subscriber.SubscribeAsync([new SubscriptionRequest(topic, 2)], CancellationToken.None);

        await publisher.PublishAsync(
            new PublishRequest(topic, "23.5"u8.ToArray(), Qos: 2, Retain: true),
            CancellationToken.None);

        var message = await delivered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(2, message.Qos);
        Assert.True(message.Retain);
    }

    /// <summary>
    /// Retain as published does not exist before MQTT 5, and MQTTnet validates its features before
    /// it sends: asking for it on a 3.1.1 link would turn every subscribe into a protocol
    /// violation. So the subscribe has to go through, and the flag has to come back as the
    /// protocol says — cleared, on a live forward.
    /// </summary>
    [Fact]
    public async Task On_a_3_1_1_link_the_subscribe_still_goes_through_and_retain_is_the_protocols_answer()
    {
        const string topic = "lab/readback/v311";

        var delivered = new TaskCompletionSource<MqttMessage>();
        var notifier = Substitute.For<IMessageNotifier>();
        notifier.NotifyMessageReceivedAsync(Arg.Do<MqttMessage>(m => delivered.TrySetResult(m)))
            .Returns(Task.CompletedTask);

        using var provider = new MqttnetClientProvider();
        var manager = new MqttnetConnectionManager(provider, Substitute.For<IConnectionStateNotifier>());
        var subscriber = new MqttnetSubscriber(provider, notifier);
        var publisher = new MqttnetPublisher(provider);

        await manager.ConnectAsync(
            Settings("console-readback-311") with { ProtocolVersion = MqttProtocolLevel.V311 },
            CancellationToken.None);
        await subscriber.SubscribeAsync([new SubscriptionRequest(topic, 2)], CancellationToken.None);

        await publisher.PublishAsync(
            new PublishRequest(topic, "23.5"u8.ToArray(), Qos: 2, Retain: true),
            CancellationToken.None);

        var message = await delivered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(2, message.Qos);
        Assert.False(message.Retain);
    }

    [Fact]
    public async Task A_publish_that_was_not_retained_leaves_nothing_behind_on_the_broker()
    {
        const string topic = "lab/retain/none";
        var (provider, publisher) = await Console_("console-retain-none");
        using var _ = provider;

        await publisher.PublishAsync(
            new PublishRequest(topic, "23.5"u8.ToArray(), Qos: 1, Retain: false),
            CancellationToken.None);

        var (witness, seen) = await Witness("witness-retain-none", topic);
        using var __ = witness;

        // Nothing stored, so nothing arrives: the wait is the assertion.
        await Assert.ThrowsAsync<TimeoutException>(
            () => seen.Task.WaitAsync(TimeSpan.FromSeconds(2)));
    }
}
