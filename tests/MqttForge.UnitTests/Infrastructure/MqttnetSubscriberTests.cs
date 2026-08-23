using MqttForge.Domain.Abstractions;
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
}
