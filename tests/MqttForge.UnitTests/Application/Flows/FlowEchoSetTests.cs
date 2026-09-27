using System.Runtime.CompilerServices;
using System.Text;
using MqttForge.Application.Flows;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Flows;

// The echo set on its own, for the one thing a flow cannot show: the rate limit keeps a flow at three
// hundred fingerprints, so its ceiling of a thousand is only reached here. The rest of what it does
// is FlowRuntimeTests', through a flow that publishes to its own filter.
public class FlowEchoSetTests
{
    private static readonly DateTimeOffset T0 = new(2026, 9, 26, 9, 0, 0, TimeSpan.Zero);

    private static MqttMessage Back(string payload) => new("plant/k1/cmd", payload, "text", 0, false, T0);

    [Fact]
    public void Past_a_thousand_fingerprints_the_oldest_goes_first()
    {
        var echo = new FlowEchoSet();

        for (var i = 0; i <= FlowLimits.EchoFingerprints; i++)
            echo.Remember("plant/k1/cmd", Encoding.UTF8.GetBytes($"{i}"), T0);

        Assert.False(echo.Heard(Back("0"), T0));
        Assert.True(echo.Heard(Back("1"), T0));
        Assert.True(echo.Heard(Back($"{FlowLimits.EchoFingerprints}"), T0));
    }

    [Fact]
    public void A_fingerprint_is_forgotten_when_its_five_seconds_are_up()
    {
        var echo = new FlowEchoSet();
        echo.Remember("plant/k1/cmd", "on"u8.ToArray(), T0);

        Assert.True(echo.Heard(Back("on"), T0 + FlowLimits.EchoWindow - TimeSpan.FromMilliseconds(1)));
        Assert.False(echo.Heard(Back("on"), T0 + FlowLimits.EchoWindow));
    }

    // A rendered topic may be as long as MQTT allows, and a flow at its rate keeps three hundred of
    // them for five seconds: kept whole, 38 MB a flow, to answer "was that me?".
    [Fact]
    public void A_topic_is_heard_again_without_being_kept()
    {
        var echo = new FlowEchoSet();
        var kept = Remember(echo, 'k');

        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();

        Assert.False(kept.IsAlive, "the topic is still held");
        Assert.True(echo.Heard(new MqttMessage(Longest('k'), "on", "text", 0, false, T0), T0));
    }

    [Fact]
    public void A_payload_published_to_one_topic_is_not_an_echo_on_another()
    {
        var echo = new FlowEchoSet();
        echo.Remember("plant/k1/cmd", "on"u8.ToArray(), T0);

        Assert.False(echo.Heard(new MqttMessage("plant/k2/cmd", "on", "text", 0, false, T0), T0));
        Assert.False(echo.Heard(new MqttMessage("plant/k1/cm", "don", "text", 0, false, T0), T0));
    }

    private static string Longest(char fill) => new(fill, FlowLimits.TopicBytes);

    /// <summary>Remembers a topic as long as MQTT allows, made here so that nothing of the test's holds it.</summary>
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static WeakReference Remember(FlowEchoSet echo, char fill)
    {
        var topic = Longest(fill);
        echo.Remember(topic, "on"u8.ToArray(), T0);
        return new WeakReference(topic);
    }
}
