using System.Text;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Alerts;
using MqttForge.Infrastructure.Mqtt;
using MqttForge.IntegrationTests.Support;
using NSubstitute;
using Xunit;

namespace MqttForge.IntegrationTests.Mqtt;

/// <summary>
/// A broker hanging up over a publish, put down to the alert rule that made it.
/// </summary>
// The broker that prompted this, mqtt.hsl.fi, closes the link on any PUBLISH at all and names
// nothing. A Mosquitto refusing an oversized packet does the same thing for a reason a test can
// produce on demand: DISCONNECT and close, straight after the publish.
public sealed class AlertPublishRefusalTests : IClassFixture<SmallPacketMosquittoFixture>
{
    private readonly SmallPacketMosquittoFixture _broker;
    public AlertPublishRefusalTests(SmallPacketMosquittoFixture broker) => _broker = broker;

    private async Task<BrokerFailure?> DroppedOverAPublishAsync(string clientId, AlertPublishWitness witness,
                                                               Action beforePublishing)
    {
        using var provider = new MqttnetClientProvider();
        var manager = new MqttnetConnectionManager(
            provider, Substitute.For<IConnectionStateNotifier>(), witness: witness);
        await manager.ConnectAsync(
            new BrokerConnectionSettings(_broker.Host, _broker.Port, clientId, null, null, false),
            CancellationToken.None);

        beforePublishing();

        var payload = Encoding.UTF8.GetBytes(new string('x', SmallPacketMosquittoFixture.MaxPacketBytes * 4));
        try
        {
            await new MqttnetPublisher(provider).PublishAsync(
                new PublishRequest("alerts/hot/plant/1", payload, 1, false), CancellationToken.None);
        }
        catch (Exception)
        {
            // The refusal itself; what is under test is what the link says about it afterwards.
        }

        // The reason arrives with MQTTnet's disconnect event, a moment after the state flips.
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (manager.Failure is null && DateTime.UtcNow < deadline)
            await Task.Delay(50);

        return manager.Failure;
    }

    [Fact]
    public async Task A_link_the_broker_closes_straight_after_an_alert_publish_names_the_rule()
    {
        var witness = new AlertPublishWitness();

        var failure = await DroppedOverAPublishAsync(
            "alert-publish-refused", witness, () => witness.Saw("Hot plant", "alerts/hot/plant/1"));

        Assert.NotNull(failure);
        Assert.Equal(BrokerFailureReason.AlertPublishRefused, failure.Reason);
        Assert.Equal(new RefusedPublish("Hot plant", "alerts/hot/plant/1"), failure.RefusedPublish);
    }

    // The same drop with no alert behind it is what it always was: nothing is pinned on a rule
    // that did not publish.
    [Fact]
    public async Task A_link_closed_with_no_alert_publish_behind_it_keeps_its_own_reason()
    {
        var failure = await DroppedOverAPublishAsync("no-alert-publish", new AlertPublishWitness(), () => { });

        Assert.NotNull(failure);
        Assert.NotEqual(BrokerFailureReason.AlertPublishRefused, failure.Reason);
        Assert.Null(failure.RefusedPublish);
    }
}
