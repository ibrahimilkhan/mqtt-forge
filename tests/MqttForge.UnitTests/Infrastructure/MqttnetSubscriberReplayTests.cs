using Microsoft.Extensions.Time.Testing;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Mqtt;
using MQTTnet;
using MQTTnet.Packets;
using MQTTnet.Protocol;
using NSubstitute;
using Xunit;

namespace MqttForge.UnitTests.Infrastructure;

/// <summary>
/// Which arrivals are the broker catching us up, and which are the plant talking.
///
/// Every SUBSCRIBE makes the broker replay the retained last value of every topic the filter
/// covers. Judged as live traffic, that backlog raises an alarm storm out of yesterday's numbers
/// on every reconnect, and — worse — resets the silence clock of a device that died last week,
/// so the one thing nobody can afford to miss is the one thing that can never be noticed.
///
/// The flag cannot be the test. SubscribeAsync asks for WithRetainAsPublished on MQTT 5, so a
/// device publishing its readings retained sends live messages with Retain set; reading the flag
/// alone would ignore that whole plant on MQTT 5 and work correctly on 3.1.1. So the question is
/// asked of the subscription instead: was a filter covering this topic granted a moment ago?
/// </summary>
public class MqttnetSubscriberReplayTests
{
    private static readonly DateTimeOffset Noon = new(2026, 8, 30, 12, 0, 0, TimeSpan.Zero);

    private readonly IMqttClient _client = Substitute.For<IMqttClient>();
    private readonly IMessageNotifier _notifier = Substitute.For<IMessageNotifier>();
    private readonly FakeTimeProvider _time = new(Noon);

    private MqttnetSubscriber CreateSut()
    {
        _client.IsConnected.Returns(true);
        return new MqttnetSubscriber(new MqttnetClientProvider(_client), _notifier, _time);
    }

    private void GivenTheBrokerGrants(params string[] filters) =>
        _client
            .SubscribeAsync(Arg.Any<MqttClientSubscribeOptions>(), Arg.Any<CancellationToken>())
            .Returns(new MqttClientSubscribeResult(
                packetIdentifier: 1,
                [.. filters.Select(filter => new MqttClientSubscribeResultItem(
                    new MqttTopicFilterBuilder().WithTopic(filter).Build(),
                    MqttClientSubscribeResultCode.GrantedQoS0))],
                reasonString: string.Empty,
                []));

    /// <summary>The broker pushing a message at us, which is the only way one ever arrives.</summary>
    private void WhenTheBrokerSends(string topic, bool retain)
    {
        var message = new MqttApplicationMessageBuilder()
            .WithTopic(topic)
            .WithPayload("21.5")
            .WithRetainFlag(retain)
            .Build();

        _client.ApplicationMessageReceivedAsync += Raise.Event<Func<MqttApplicationMessageReceivedEventArgs, Task>>(
            new MqttApplicationMessageReceivedEventArgs(
                "console", message, new MqttPublishPacket(), (_, _) => Task.CompletedTask));
    }

    private async Task ItWasCalledReplay(bool expected) =>
        await _notifier.Received(1).NotifyMessageReceivedAsync(
            Arg.Is<MqttMessage>(m => m != null && m.Replay == expected));

    [Fact]
    public async Task A_retained_message_just_after_the_suback_is_a_replay()
    {
        GivenTheBrokerGrants("plant/#");
        var sut = CreateSut();
        await sut.SubscribeAsync([new SubscriptionRequest("plant/#", 0)], CancellationToken.None);

        _time.Advance(TimeSpan.FromMilliseconds(400));
        WhenTheBrokerSends("plant/a/temp", retain: true);

        await ItWasCalledReplay(true);
    }

    // The boundary is inclusive, as every other deadline in this product is: two seconds after
    // the SUBACK is still the broker catching up, and 2.001 is not.
    [Fact]
    public async Task A_retained_message_at_exactly_two_seconds_is_still_a_replay()
    {
        GivenTheBrokerGrants("plant/#");
        var sut = CreateSut();
        await sut.SubscribeAsync([new SubscriptionRequest("plant/#", 0)], CancellationToken.None);

        _time.Advance(TimeSpan.FromSeconds(2));
        WhenTheBrokerSends("plant/a/temp", retain: true);

        await ItWasCalledReplay(true);
    }

    [Fact]
    public async Task A_retained_message_a_millisecond_past_the_window_is_live()
    {
        GivenTheBrokerGrants("plant/#");
        var sut = CreateSut();
        await sut.SubscribeAsync([new SubscriptionRequest("plant/#", 0)], CancellationToken.None);

        _time.Advance(TimeSpan.FromMilliseconds(2001));
        WhenTheBrokerSends("plant/a/temp", retain: true);

        await ItWasCalledReplay(false);
    }

    // The case the whole design exists for. A plant that publishes its readings retained sends
    // live messages with the flag set, and an hour into the session they are still readings.
    [Fact]
    public async Task A_retained_message_long_after_the_suback_is_live()
    {
        GivenTheBrokerGrants("plant/#");
        var sut = CreateSut();
        await sut.SubscribeAsync([new SubscriptionRequest("plant/#", 0)], CancellationToken.None);

        _time.Advance(TimeSpan.FromHours(1));
        WhenTheBrokerSends("plant/a/temp", retain: true);

        await ItWasCalledReplay(false);
    }

    // A broker never replays what was not retained, so this one needs no window at all.
    [Fact]
    public async Task A_message_that_is_not_retained_is_never_a_replay()
    {
        GivenTheBrokerGrants("plant/#");
        var sut = CreateSut();
        await sut.SubscribeAsync([new SubscriptionRequest("plant/#", 0)], CancellationToken.None);

        WhenTheBrokerSends("plant/a/temp", retain: false);

        await ItWasCalledReplay(false);
    }

    // A subscription replays its own tree and nobody else's. Asking 'did we subscribe to anything
    // recently' instead would silence a live reading on an untouched filter every time a rule was
    // saved.
    [Fact]
    public async Task A_fresh_subscription_does_not_make_another_filters_traffic_a_replay()
    {
        GivenTheBrokerGrants("lab/#");
        var sut = CreateSut();
        await sut.SubscribeAsync([new SubscriptionRequest("lab/#", 0)], CancellationToken.None);

        _time.Advance(TimeSpan.FromHours(1));
        GivenTheBrokerGrants("plant/#");
        await sut.SubscribeAsync([new SubscriptionRequest("plant/#", 0)], CancellationToken.None);

        WhenTheBrokerSends("lab/oven/temp", retain: true);

        await ItWasCalledReplay(false);
    }

    // Subscribing again to a filter that is already up gets the backlog again — the broker
    // replays for every SUBSCRIBE it accepts, not only for the first — so the window moves.
    [Fact]
    public async Task Subscribing_again_to_a_live_filter_reopens_its_replay_window()
    {
        GivenTheBrokerGrants("plant/#");
        var sut = CreateSut();
        await sut.SubscribeAsync([new SubscriptionRequest("plant/#", 0)], CancellationToken.None);

        _time.Advance(TimeSpan.FromHours(1));
        await sut.SubscribeAsync([new SubscriptionRequest("plant/#", 0)], CancellationToken.None);

        WhenTheBrokerSends("plant/a/temp", retain: true);

        await ItWasCalledReplay(true);
    }

    // A retained message on a topic nothing covers has no grant to be recent. It reaches the
    // console as an ordinary arrival, because the log and the tree are drawn from what arrived
    // and not from what the engine was willing to judge.
    [Fact]
    public async Task A_retained_message_no_filter_covers_is_live()
    {
        GivenTheBrokerGrants("plant/#");
        var sut = CreateSut();
        await sut.SubscribeAsync([new SubscriptionRequest("plant/#", 0)], CancellationToken.None);

        WhenTheBrokerSends("lab/oven/temp", retain: true);

        await ItWasCalledReplay(false);
    }

    // The stamp on the message is the subscriber's clock too, so the engine's idea of when a
    // topic last spoke and its idea of now come from one place.
    [Fact]
    public async Task An_arrival_carries_the_moment_it_was_received()
    {
        GivenTheBrokerGrants("plant/#");
        var sut = CreateSut();
        await sut.SubscribeAsync([new SubscriptionRequest("plant/#", 0)], CancellationToken.None);

        _time.Advance(TimeSpan.FromMinutes(5));
        WhenTheBrokerSends("plant/a/temp", retain: false);

        await _notifier.Received(1).NotifyMessageReceivedAsync(
            Arg.Is<MqttMessage>(m => m != null && m.ReceivedAt == Noon.AddMinutes(5)));
    }
}
