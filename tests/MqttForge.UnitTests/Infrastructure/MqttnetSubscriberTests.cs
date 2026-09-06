using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Mqtt;
using MQTTnet;
using MQTTnet.Exceptions;
using MQTTnet.Packets;
using MQTTnet.Protocol;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using Xunit;

namespace MqttForge.UnitTests.Infrastructure;

/// <summary>
/// What a refused subscription is allowed to look like from the outside.
///
/// Two shapes, and the dramatic one was handled first. A broker may refuse a filter by closing
/// the session rather than by answering the SUBSCRIBE, which is what mqtt.hsl.fi does to a
/// wildcard it considers too broad. MQTTnet raises that as an unexpected DISCONNECT, and until it
/// was caught it travelled all the way out as an unhandled exception: HTTP 500, 'An error
/// occurred while processing your request', and a console line that named neither the filter nor
/// the broker's objection.
///
/// The ordinary shape is quieter and was missed for longer: the broker answers the SUBSCRIBE, and
/// the SUBACK carries a reason code per filter saying which it granted and which it turned down.
/// Nothing read those codes, so a refused filter was recorded as active and the console listed a
/// subscription it did not have.
/// </summary>
public class MqttnetSubscriberTests
{
    private readonly IMqttClient _client = Substitute.For<IMqttClient>();

    private MqttnetSubscriber CreateSut()
    {
        _client.IsConnected.Returns(true);
        return new MqttnetSubscriber(new MqttnetClientProvider(_client), Substitute.For<IMessageNotifier>());
    }

    private void GivenTheBrokerDisconnectsOnSubscribe(MqttDisconnectReasonCode code) =>
        _client
            .SubscribeAsync(Arg.Any<MqttClientSubscribeOptions>(), Arg.Any<CancellationToken>())
            .ThrowsAsync(new MqttClientUnexpectedDisconnectReceivedException(
                new MqttDisconnectPacket { ReasonCode = code }));

    /// <summary>The SUBACK a broker sends back, one reason code per filter asked for.</summary>
    private void GivenTheBrokerAnswers(params (string Filter, MqttClientSubscribeResultCode Code)[] answers) =>
        _client
            .SubscribeAsync(Arg.Any<MqttClientSubscribeOptions>(), Arg.Any<CancellationToken>())
            .Returns(new MqttClientSubscribeResult(
                packetIdentifier: 1,
                [.. answers.Select(answer => new MqttClientSubscribeResultItem(
                    new MqttTopicFilterBuilder().WithTopic(answer.Filter).Build(), answer.Code))],
                reasonString: string.Empty,
                []));

    private static IReadOnlyList<SubscriptionRequest> Asking(params string[] filters) =>
        [.. filters.Select(filter => new SubscriptionRequest(filter, 0))];

    // Azure IoT Hub is 3.1.1-only and answers a filter it does not allow by closing the TCP
    // socket with no packet at all. Read as 'the link died' it left the filter unnamed and the
    // reader with nothing to narrow.
    [Fact]
    public async Task A_session_closed_while_subscribing_is_a_refused_filter()
    {
        _client
            .SubscribeAsync(Arg.Any<MqttClientSubscribeOptions>(), Arg.Any<CancellationToken>())
            .ThrowsAsync(new MqttCommunicationException("Connection closed."));

        var thrown = await Assert.ThrowsAsync<MessageRejectedException>(() =>
            CreateSut().SubscribeAsync(Asking("#"), CancellationToken.None));

        Assert.Contains("'#'", thrown.Message);
        Assert.Equal(["#"], thrown.Filters);
    }

    private static bool AsksForEverythingAtQoS2(MqttClientSubscribeOptions? options)
    {
        var filters = options?.TopicFilters;

        return filters is { Count: 1 }
            && filters[0].Topic == "#"
            && filters[0].QualityOfServiceLevel == MqttQualityOfServiceLevel.ExactlyOnce;
    }

    private void RaiseDisconnected(bool clientWasConnected = true) =>
        _client.DisconnectedAsync += Raise.Event<Func<MqttClientDisconnectedEventArgs, Task>>(
            new MqttClientDisconnectedEventArgs(
                clientWasConnected: clientWasConnected, connectResult: null,
                reason: MqttClientDisconnectReason.UnspecifiedError, reasonString: null,
                userProperties: null, exception: null));

    // An outage that takes more than one rung. MQTTnet raises DisconnectedAsync on the failed
    // connect path too, with nothing subscribed — and that used to overwrite the stash, so the
    // rung that finally worked restored nothing and the reader watched a green link carrying
    // none of their topics.
    [Fact]
    public async Task A_failed_rung_between_the_drop_and_the_redial_does_not_lose_the_filters()
    {
        GivenTheBrokerAnswers(("#", MqttClientSubscribeResultCode.GrantedQoS2));
        var sut = CreateSut();
        await sut.SubscribeAsync([new SubscriptionRequest("#", 2)], CancellationToken.None);

        RaiseDisconnected();                               // the drop
        RaiseDisconnected(clientWasConnected: false);      // rung 1 never lands
        RaiseDisconnected(clientWasConnected: false);      // rung 2 never lands
        _client.ClearReceivedCalls();

        GivenTheBrokerAnswers(("#", MqttClientSubscribeResultCode.GrantedQoS2));
        await sut.RestoreConsoleFiltersAsync(CancellationToken.None);

        await _client.Received(1).SubscribeAsync(
            Arg.Is<MqttClientSubscribeOptions>(options => AsksForEverythingAtQoS2(options)),
            Arg.Any<CancellationToken>());
        Assert.Equal(["#"], sut.ActiveFilters);
    }

    // What the console held when the link went is asked for again on the redial — at the QoS it
    // had — and the engine's own filters are not, because the engine puts those back itself.
    [Fact]
    public async Task Restoring_asks_again_for_the_consoles_filters_and_only_those()
    {
        GivenTheBrokerAnswers(("#", MqttClientSubscribeResultCode.GrantedQoS2));
        var sut = CreateSut();
        await sut.SubscribeAsync([new SubscriptionRequest("#", 2)], CancellationToken.None);
        GivenTheBrokerAnswers(("plant/#", MqttClientSubscribeResultCode.GrantedQoS0));
        await sut.SubscribeAsync(Asking("plant/#"), CancellationToken.None, SubscriptionOwner.Rules);
        _client.ClearReceivedCalls();

        RaiseDisconnected();
        Assert.Empty(sut.ActiveFilters);

        GivenTheBrokerAnswers(("#", MqttClientSubscribeResultCode.GrantedQoS2));
        await sut.RestoreConsoleFiltersAsync(CancellationToken.None);

        await _client.Received(1).SubscribeAsync(
            Arg.Is<MqttClientSubscribeOptions>(options => AsksForEverythingAtQoS2(options)),
            Arg.Any<CancellationToken>());
        Assert.Equal(["#"], sut.ActiveFilters);
    }

    [Fact]
    public async Task Restoring_twice_asks_once()
    {
        GivenTheBrokerAnswers(("#", MqttClientSubscribeResultCode.GrantedQoS0));
        var sut = CreateSut();
        await sut.SubscribeAsync(Asking("#"), CancellationToken.None);
        RaiseDisconnected();
        _client.ClearReceivedCalls();

        await sut.RestoreConsoleFiltersAsync(CancellationToken.None);
        await sut.RestoreConsoleFiltersAsync(CancellationToken.None);

        await _client.Received(1).SubscribeAsync(Arg.Any<MqttClientSubscribeOptions>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Restoring_with_nothing_held_asks_for_nothing()
    {
        var sut = CreateSut();

        await sut.RestoreConsoleFiltersAsync(CancellationToken.None);

        await _client.DidNotReceive().SubscribeAsync(Arg.Any<MqttClientSubscribeOptions>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task SubscribeAsync_reports_a_filter_the_broker_closed_the_session_over()
    {
        GivenTheBrokerDisconnectsOnSubscribe(MqttDisconnectReasonCode.NotAuthorized);

        await Assert.ThrowsAsync<MessageRejectedException>(() =>
            CreateSut().SubscribeAsync([new SubscriptionRequest("#", 0)], CancellationToken.None));
    }

    [Fact]
    public async Task SubscribeAsync_names_the_filter_that_was_refused()
    {
        GivenTheBrokerDisconnectsOnSubscribe(MqttDisconnectReasonCode.TopicFilterInvalid);

        var thrown = await Assert.ThrowsAsync<MessageRejectedException>(() =>
            CreateSut().SubscribeAsync([new SubscriptionRequest("#", 0)], CancellationToken.None));

        Assert.Contains("'#'", thrown.Message);
    }

    // A refusal is not a subscription. Leaving the filter in the active list meant the console
    // listed one the broker had just thrown the session away over.
    [Fact]
    public async Task SubscribeAsync_does_not_record_a_filter_the_broker_refused()
    {
        GivenTheBrokerDisconnectsOnSubscribe(MqttDisconnectReasonCode.NotAuthorized);
        var sut = CreateSut();

        await Assert.ThrowsAsync<MessageRejectedException>(() =>
            sut.SubscribeAsync([new SubscriptionRequest("#", 0)], CancellationToken.None));

        Assert.DoesNotContain("#", sut.ActiveFilters);
    }

    [Fact]
    public async Task SubscribeAsync_records_a_filter_the_broker_granted()
    {
        GivenTheBrokerAnswers(("sensors/#", MqttClientSubscribeResultCode.GrantedQoS0));
        var sut = CreateSut();

        await sut.SubscribeAsync(Asking("sensors/#"), CancellationToken.None);

        Assert.Contains("sensors/#", sut.ActiveFilters);
    }

    // The refusal that arrives as an answer rather than as an exception. Unread, this was the one
    // way a filter could be turned down and still be listed as a live subscription.
    [Theory]
    [InlineData(MqttClientSubscribeResultCode.NotAuthorized)]
    [InlineData(MqttClientSubscribeResultCode.TopicFilterInvalid)]
    [InlineData(MqttClientSubscribeResultCode.QuotaExceeded)]
    [InlineData(MqttClientSubscribeResultCode.WildcardSubscriptionsNotSupported)]
    public async Task SubscribeAsync_reports_a_filter_the_suback_refused(MqttClientSubscribeResultCode code)
    {
        GivenTheBrokerAnswers(("sensors/#", code));
        var sut = CreateSut();

        var thrown = await Assert.ThrowsAsync<MessageRejectedException>(() =>
            sut.SubscribeAsync(Asking("sensors/#"), CancellationToken.None));

        Assert.Contains("sensors/#", thrown.Message);
        Assert.Contains(code.ToString(), thrown.Message);
        Assert.DoesNotContain("sensors/#", sut.ActiveFilters);
    }

    // A batch is one packet but not one decision. What the broker granted is genuinely up, and
    // dropping it along with the refusal would leave the console wrong in the other direction.
    [Fact]
    public async Task SubscribeAsync_keeps_what_a_partly_refused_batch_granted()
    {
        GivenTheBrokerAnswers(
            ("sensors/#", MqttClientSubscribeResultCode.GrantedQoS0),
            ("$SYS/#", MqttClientSubscribeResultCode.NotAuthorized));
        var sut = CreateSut();

        var thrown = await Assert.ThrowsAsync<MessageRejectedException>(() =>
            sut.SubscribeAsync(Asking("sensors/#", "$SYS/#"), CancellationToken.None));

        Assert.Contains("$SYS/#", thrown.Message);
        Assert.DoesNotContain("sensors/#", thrown.Message);
        Assert.Contains("sensors/#", sut.ActiveFilters);
        Assert.DoesNotContain("$SYS/#", sut.ActiveFilters);
    }

    /// <summary>
    /// One message, two standing orders, two copies. A broker is required to send a copy per
    /// matching subscription, so a console listening to '#' that also holds 'plant/#' — a filter
    /// chip, or any saved alert rule — counts everything under plant twice.
    /// </summary>
    public class NotAskingTwice
    {
        private readonly IMqttClient _client = Substitute.For<IMqttClient>();

        private MqttnetSubscriber CreateSut()
        {
            _client.IsConnected.Returns(true);
            Answers();
            return new MqttnetSubscriber(new MqttnetClientProvider(_client), Substitute.For<IMessageNotifier>());
        }

        /// <summary>A broker that grants whatever it is asked for.</summary>
        private void Answers() =>
            _client
                .SubscribeAsync(Arg.Any<MqttClientSubscribeOptions>(), Arg.Any<CancellationToken>())
                .Returns(call =>
                {
                    var options = (MqttClientSubscribeOptions)call[0]!;
                    var filters = options.TopicFilters ?? [];

                    return new MqttClientSubscribeResult(
                        packetIdentifier: 1,
                        [.. filters.Select(filter =>
                            new MqttClientSubscribeResultItem(filter, MqttClientSubscribeResultCode.GrantedQoS0))],
                        reasonString: string.Empty,
                        []);
                });

        private List<string> Asked() =>
        [
            .. _client.ReceivedCalls()
                .Where(call => call.GetMethodInfo().Name == nameof(IMqttClient.SubscribeAsync))
                .SelectMany(call => ((MqttClientSubscribeOptions)call.GetArguments()[0]!).TopicFilters ?? [])
                .Select(filter => filter.Topic),
        ];

        /// <summary>
        /// What was let go of at the broker. The string overload of UnsubscribeAsync is an
        /// extension, so what the substitute sees is the options object it builds.
        /// </summary>
        private List<string> Dropped() =>
        [
            .. _client.ReceivedCalls()
                .Where(call => call.GetMethodInfo().Name == nameof(IMqttClient.UnsubscribeAsync))
                .SelectMany(call => ((MqttClientUnsubscribeOptions)call.GetArguments()[0]!).TopicFilters ?? []),
        ];

        private static IReadOnlyList<SubscriptionRequest> Asking(params string[] filters) =>
            [.. filters.Select(filter => new SubscriptionRequest(filter, 0))];

        [Fact]
        public async Task A_filter_a_live_one_already_covers_is_not_asked_for()
        {
            var sut = CreateSut();

            await sut.SubscribeAsync(Asking("#"), CancellationToken.None);
            await sut.SubscribeAsync(Asking("plant/#"), CancellationToken.None, SubscriptionOwner.Rules);

            Assert.Equal(["#"], Asked());
        }

        [Fact]
        public async Task But_the_console_goes_on_holding_it()
        {
            var sut = CreateSut();

            await sut.SubscribeAsync(Asking("#"), CancellationToken.None);
            await sut.SubscribeAsync(Asking("plant/#"), CancellationToken.None, SubscriptionOwner.Rules);

            Assert.Contains("plant/#", sut.ActiveFilters);
        }

        [Fact]
        public async Task A_batch_is_sifted_against_itself_too_since_a_redial_restores_it_whole()
        {
            var sut = CreateSut();

            await sut.SubscribeAsync(Asking("plant/#", "#", "plant/boiler/temp"), CancellationToken.None);

            Assert.Equal(["#"], Asked());
            Assert.Equal(3, sut.ActiveFilters.Count);
        }

        [Fact]
        public async Task A_filter_that_covers_a_live_one_takes_it_down()
        {
            var sut = CreateSut();

            await sut.SubscribeAsync(Asking("plant/#"), CancellationToken.None, SubscriptionOwner.Rules);
            await sut.SubscribeAsync(Asking("#"), CancellationToken.None);

            Assert.Equal(["plant/#", "#"], Asked());
            Assert.Equal(["plant/#"], Dropped());
            Assert.Contains("plant/#", sut.ActiveFilters);
        }

        [Fact]
        public async Task What_a_departing_filter_was_covering_is_asked_for_properly()
        {
            var sut = CreateSut();

            await sut.SubscribeAsync(Asking("#"), CancellationToken.None);
            await sut.SubscribeAsync(Asking("plant/#"), CancellationToken.None, SubscriptionOwner.Rules);

            await sut.UnsubscribeAsync("#", CancellationToken.None);

            Assert.Equal(["#", "plant/#"], Asked());
            Assert.Equal(["plant/#"], sut.ActiveFilters);
        }

        [Fact]
        public async Task Letting_go_of_a_covered_filter_sends_no_packet_about_it()
        {
            var sut = CreateSut();

            await sut.SubscribeAsync(Asking("#"), CancellationToken.None);
            await sut.SubscribeAsync(Asking("plant/#"), CancellationToken.None, SubscriptionOwner.Rules);

            await sut.UnsubscribeAsync("plant/#", CancellationToken.None, SubscriptionOwner.Rules);

            Assert.Empty(Dropped());
            Assert.DoesNotContain("plant/#", sut.ActiveFilters);
        }

        /// <summary>
        /// A wide filter only stands in for a narrow one if it carries the traffic as firmly. A
        /// reader who asked for QoS 1 under a '#' taken at QoS 0 asked for something the '#'
        /// cannot give them.
        /// </summary>
        [Fact]
        public async Task A_lower_QoS_does_not_cover_a_higher_one()
        {
            var sut = CreateSut();

            await sut.SubscribeAsync(Asking("#"), CancellationToken.None);
            await sut.SubscribeAsync([new SubscriptionRequest("plant/#", 1)], CancellationToken.None);

            Assert.Equal(["#", "plant/#"], Asked());
        }

        /// <summary>
        /// The one wildcard that reaches nothing: a filter beginning with '#' or '+' cannot match
        /// a topic beginning with '$', which is why the console asks for the broker's statistics
        /// separately. Reading '#' as covering them would turn the box off.
        /// </summary>
        [Fact]
        public async Task The_brokers_own_tree_is_asked_for_even_under_a_hash()
        {
            var sut = CreateSut();

            await sut.SubscribeAsync(Asking("#", "$SYS/#"), CancellationToken.None);

            Assert.Equal(["#", "$SYS/#"], Asked());
        }
    }
}
