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
}
