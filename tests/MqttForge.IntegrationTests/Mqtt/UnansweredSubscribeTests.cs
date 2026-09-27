using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Mqtt;
using MqttForge.IntegrationTests.Support;
using MQTTnet;
using NSubstitute;
using Xunit;

namespace MqttForge.IntegrationTests.Mqtt;

/// <summary>
/// A broker that keeps the link and stops answering, and a link that goes under a SUBSCRIBE still
/// waiting for its answer — against a real Mosquitto, frozen with the link open.
/// </summary>
// The subscriber's callers all have tokens that can be cancelled, and MQTTnet keeps its own timeout
// only for a caller that has none, so what is proved here is the deadline the subscriber gives the
// wait itself: ten seconds of its own, whatever the client's timeout.
public sealed class UnansweredSubscribeTests : IClassFixture<MosquittoFixture>
{
    private readonly MosquittoFixture _broker;

    public UnansweredSubscribeTests(MosquittoFixture broker) => _broker = broker;

    private async Task<MqttnetClientProvider> ConnectedAsync(string clientId, TimeSpan timeout)
    {
        var provider = new MqttnetClientProvider();

        await provider.Client.ConnectAsync(new MqttClientOptionsBuilder()
            .WithTcpServer(_broker.Host, _broker.Port)
            .WithClientId(clientId)
            .WithTimeout(timeout)
            .Build());

        return provider;
    }

    // MQTTnet's own timeout on the client, a hundred seconds, as the product's client has it: the
    // SUBSCRIBE is given up at the subscriber's ten all the same.
    [Fact]
    public async Task A_subscribe_a_frozen_broker_never_answers_is_given_up_after_ten_seconds()
    {
        using var provider = await ConnectedAsync("frozen-subscribe", new MqttClientOptions().Timeout);
        var subscriber = new MqttnetSubscriber(provider, Substitute.For<IMessageNotifier>());

        await _broker.PauseAsync();
        try
        {
            using var caller = new CancellationTokenSource();

            var thrown = await Assert.ThrowsAsync<BrokerDidNotAnswerException>(() => subscriber
                .SubscribeAsync([new SubscriptionRequest("plant/#", 1)], caller.Token)
                .WaitAsync(TimeSpan.FromSeconds(20)));

            Assert.Contains("'plant/#'", thrown.Message);
            Assert.Contains("within 10 seconds", thrown.Message);
            Assert.Empty(subscriber.ActiveFilters);
            Assert.True(provider.Client.IsConnected, "the link should still be up: the broker only stopped answering");
        }
        finally
        {
            await _broker.UnpauseAsync();
        }
    }

    // What MQTTnet hands a SUBSCRIBE still out when the link under it goes: here the client's own
    // disconnect, which is what a reader moving the link to another broker does to an engine's.
    [Fact]
    public async Task A_link_that_goes_under_a_waiting_subscribe_is_a_link_that_went()
    {
        using var provider = await ConnectedAsync("dropped-subscribe", TimeSpan.FromSeconds(60));
        var subscriber = new MqttnetSubscriber(provider, Substitute.For<IMessageNotifier>());

        await _broker.PauseAsync();
        try
        {
            using var caller = new CancellationTokenSource();
            var asking = subscriber.SubscribeAsync([new SubscriptionRequest("plant/#", 1)], caller.Token);

            // Out, and waiting for the SUBACK a frozen broker will not send.
            await Task.Delay(TimeSpan.FromMilliseconds(500));
            Assert.False(asking.IsCompleted);

            await provider.Client.DisconnectAsync();

            var thrown = await Assert.ThrowsAsync<NotConnectedException>(() => asking.WaitAsync(TimeSpan.FromSeconds(20)));
            Assert.Contains("'plant/#'", thrown.Message);
        }
        finally
        {
            await _broker.UnpauseAsync();
        }
    }
}
