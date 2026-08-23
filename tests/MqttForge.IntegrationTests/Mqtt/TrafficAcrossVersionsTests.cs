using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Mqtt;
using MqttForge.IntegrationTests.Support;
using MQTTnet;
using NSubstitute;
using Xunit;

namespace MqttForge.IntegrationTests.Mqtt;

/// <summary>Messages actually moving, on every version and over every transport.</summary>
// The connection tests prove a link comes up. That is not the same as the console working on
// it: SUBSCRIBE, PUBLISH and the packets coming back are separate exchanges, and a version or a
// transport that connected and then could not carry traffic would pass every other test here.
//
// One test per combination rather than one that loops, so a failure names which of the eight it
// was rather than the first one that broke.
public class TrafficAcrossVersionsTests : IClassFixture<TransportMosquittoFixture>
{
    private readonly TransportMosquittoFixture _broker;

    public TrafficAcrossVersionsTests(TransportMosquittoFixture broker) => _broker = broker;

    [Theory]
    [InlineData(MqttProtocolLevel.V500)]
    [InlineData(MqttProtocolLevel.V311)]
    [InlineData(MqttProtocolLevel.V310)]
    [InlineData(MqttProtocolLevel.Auto)]
    public async Task A_message_published_on_any_version_comes_back_on_a_subscription(
        MqttProtocolLevel version)
    {
        await AssertRoundTrip(
            Settings($"traffic-{version}", _broker.Plain) with { ProtocolVersion = version });
    }

    [Fact]
    public async Task A_message_travels_through_a_WebSocket_as_well_as_a_socket()
    {
        await AssertRoundTrip(
            Settings("traffic-ws", _broker.WebSocket) with { Transport = MqttTransport.WebSocket });
    }

    [Fact]
    public async Task A_message_travels_through_an_encrypted_WebSocket()
    {
        await AssertRoundTrip(
            Settings("traffic-wss", _broker.SecureWebSocket) with
            {
                Transport = MqttTransport.WebSocket,
                UseTls = true,
                Tls = new BrokerTlsSettings(CertificateAuthorityPath: _broker.Certificates.AuthorityPath),
            });
    }

    [Fact]
    public async Task A_message_travels_over_TLS()
    {
        await AssertRoundTrip(
            Settings("traffic-tls", _broker.Tls) with
            {
                UseTls = true,
                Tls = new BrokerTlsSettings(CertificateAuthorityPath: _broker.Certificates.AuthorityPath),
            });
    }

    // An older version reaching the broker inside a WebSocket: the two are independent, and the
    // combination is the one nothing else in the suite exercises.
    [Fact]
    public async Task An_older_version_carries_traffic_through_a_WebSocket()
    {
        await AssertRoundTrip(
            Settings("traffic-ws-311", _broker.WebSocket) with
            {
                Transport = MqttTransport.WebSocket,
                ProtocolVersion = MqttProtocolLevel.V311,
            });
    }

    private BrokerConnectionSettings Settings(string clientId, int port) =>
        new(_broker.Host, port, clientId, null, null, false);

    // Publish through the console's own publisher, subscribe through its own subscriber, and
    // read what the notifier was handed — so the whole path is the one the app uses, not a
    // second MQTT client standing in for half of it.
    private static async Task AssertRoundTrip(BrokerConnectionSettings settings)
    {
        var topic = $"mqttforge/{settings.ClientId}/reading";

        using var provider = new MqttnetClientProvider();
        var manager = new MqttnetConnectionManager(provider, Substitute.For<IConnectionStateNotifier>());
        var publisher = new MqttnetPublisher(provider);

        var arrived = new TaskCompletionSource<MqttMessage>();
        var notifier = Substitute.For<IMessageNotifier>();
        notifier
            .When(n => n.NotifyMessageReceivedAsync(Arg.Any<MqttMessage>()))
            .Do(call => arrived.TrySetResult(call.Arg<MqttMessage>()!));

        var subscriber = new MqttnetSubscriber(provider, notifier);

        await manager.ConnectAsync(settings, CancellationToken.None);
        Assert.Equal(ConnectionState.Connected, manager.State);

        await subscriber.SubscribeAsync([new SubscriptionRequest(topic, 0)], CancellationToken.None);
        await publisher.PublishAsync(
            new PublishRequest(topic, "23.5"u8.ToArray(), 0, false), CancellationToken.None);

        var message = await arrived.Task.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal(topic, message.Topic);
        Assert.Equal("23.5", message.Payload);

        await manager.DisconnectAsync(CancellationToken.None);
    }
}
