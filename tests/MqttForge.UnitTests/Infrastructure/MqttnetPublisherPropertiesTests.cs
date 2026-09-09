using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Mqtt;
using MQTTnet;
using MQTTnet.Formatter;
using NSubstitute;
using Xunit;

namespace MqttForge.UnitTests.Infrastructure;

/// <summary>
/// What MQTT 5 lets a message carry, and what happens to it on a link that cannot.
///
/// The interesting half is the refusal. 3.1.1 has no room for a content type or a correlation id,
/// and MQTTnet says so by throwing when one is built onto a message on such a link — but the
/// tempting fix is to drop them quietly, and a request published without the correlation id it
/// was given is a reply the caller will wait for and never recognise. So the publisher answers
/// instead, and names the link's own version.
/// </summary>
public class MqttnetPublisherPropertiesTests
{
    private readonly IMqttClient _client = Substitute.For<IMqttClient>();

    private MqttnetPublisher Speaking(MqttProtocolVersion version)
    {
        _client.IsConnected.Returns(true);
        _client.Options.Returns(new MqttClientOptions
        {
            ProtocolVersion = version,
            ChannelOptions = new MqttClientTcpOptions { RemoteEndpoint = null },
        });

        return new MqttnetPublisher(new MqttnetClientProvider(_client));
    }

    private MqttApplicationMessage Sent() =>
        (MqttApplicationMessage)_client.ReceivedCalls()
            .First(call => call.GetMethodInfo().Name == nameof(IMqttClient.PublishAsync))
            .GetArguments()[0]!;

    private static PublishRequest Message(PublishProperties? properties) =>
        new("sensors/temp", "23.5"u8.ToArray(), 0, false, properties);

    private static readonly PublishProperties Everything = new(
        "application/json",
        "sensors/temp/reply",
        "abc-123"u8.ToArray(),
        60,
        [new UserProperty("source", "console")]);

    [Fact]
    public async Task Carries_all_of_it_on_a_five_link()
    {
        var publisher = Speaking(MqttProtocolVersion.V500);

        await publisher.PublishAsync(Message(Everything), CancellationToken.None);

        var sent = Sent();
        Assert.Equal("application/json", sent.ContentType);
        Assert.Equal("sensors/temp/reply", sent.ResponseTopic);
        Assert.Equal("abc-123"u8.ToArray(), sent.CorrelationData);
        Assert.Equal(60u, sent.MessageExpiryInterval);
        var one = Assert.Single(sent.UserProperties!);
        Assert.Equal("source", one.Name);
        Assert.Equal("console", System.Text.Encoding.UTF8.GetString(one.ValueBuffer.Span));
    }

    [Fact]
    public async Task Refuses_it_on_a_three_link_rather_than_dropping_it()
    {
        var publisher = Speaking(MqttProtocolVersion.V311);

        var refused = await Assert.ThrowsAsync<MessageRejectedException>(
            () => publisher.PublishAsync(Message(Everything), CancellationToken.None));

        Assert.Contains("MQTT 5", refused.Message);
        Assert.DoesNotContain(
            _client.ReceivedCalls(),
            call => call.GetMethodInfo().Name == nameof(IMqttClient.PublishAsync));
    }

    // The ordinary publish, which is every publish the console has made until now.
    [Fact]
    public async Task A_message_carrying_none_of_it_goes_out_on_either_link()
    {
        var publisher = Speaking(MqttProtocolVersion.V311);

        await publisher.PublishAsync(Message(null), CancellationToken.None);

        Assert.Equal("sensors/temp", Sent().Topic);
    }
}
