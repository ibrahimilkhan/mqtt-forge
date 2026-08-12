using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Mqtt;
using MqttForge.IntegrationTests.Support;
using NSubstitute;
using Xunit;

namespace MqttForge.IntegrationTests.Mqtt;

// Closes the branch's headline claim — raw bytes go out and come back intact — with a real
// broker in the loop instead of the manual checklist it shipped with.
public class BinaryPayloadRoundTripTests : IClassFixture<MosquittoFixture>
{
    private readonly MosquittoFixture _broker;

    public BinaryPayloadRoundTripTests(MosquittoFixture broker) => _broker = broker;

    private BrokerConnectionSettings Settings(string clientId) =>
        new(_broker.Host, _broker.Port, clientId, null, null, false);

    [Fact]
    public async Task Binary_payload_survives_publish_and_arrives_as_base64()
    {
        var delivered = new TaskCompletionSource<MqttMessage>();
        var notifier = Substitute.For<IMessageNotifier>();
        notifier.NotifyMessageReceivedAsync(Arg.Do<MqttMessage>(m => delivered.TrySetResult(m)))
            .Returns(Task.CompletedTask);

        using var provider = new MqttnetClientProvider();
        var manager = new MqttnetConnectionManager(provider, Substitute.For<IConnectionStateNotifier>());
        var subscriber = new MqttnetSubscriber(provider, notifier);
        var publisher = new MqttnetPublisher(provider);

        await manager.ConnectAsync(Settings("binary-round-trip"), CancellationToken.None);
        await subscriber.SubscribeAsync([new SubscriptionRequest("device/binary", 0)], CancellationToken.None);

        byte[] bytes = [0x01, 0xA4, 0xFF];
        await publisher.PublishAsync(new PublishRequest("device/binary", bytes, 0, false), CancellationToken.None);

        var message = await delivered.Task.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal("base64", message.PayloadEncoding);
        Assert.Equal(bytes, Convert.FromBase64String(message.Payload));
    }
}
