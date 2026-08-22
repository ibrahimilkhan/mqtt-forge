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
/// A broker may refuse a filter by closing the session rather than by answering the SUBSCRIBE,
/// which is what mqtt.hsl.fi does to a wildcard it considers too broad. MQTTnet raises that as
/// an unexpected DISCONNECT, and until this was caught it travelled all the way out as an
/// unhandled exception: HTTP 500, 'An error occurred while processing your request', and a
/// console line that named neither the filter nor the broker's objection.
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
}
