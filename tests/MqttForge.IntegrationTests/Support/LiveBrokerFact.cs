using Xunit;

namespace MqttForge.IntegrationTests.Support;

/// <summary>A test that dials a broker out on the internet, and is skipped unless asked for.</summary>
// Off by default, and off in CI. What these prove is that MQTTForge reaches brokers it does not
// control — which is worth proving, and is exactly why it cannot be a gate: the brokers are
// somebody else's, they go down, they rate-limit, and a build that fails because a free public
// broker was busy teaches nobody anything.
//
// Run them deliberately:  MQTTFORGE_LIVE=1 dotnet test --filter LiveBroker
public sealed class LiveBrokerFactAttribute : FactAttribute
{
    public LiveBrokerFactAttribute()
    {
        if (!Enabled) Skip = "Set MQTTFORGE_LIVE=1 to dial brokers out on the internet.";
    }

    public static bool Enabled =>
        Environment.GetEnvironmentVariable("MQTTFORGE_LIVE") is "1" or "true";
}

/// <inheritdoc cref="LiveBrokerFactAttribute"/>
public sealed class LiveBrokerTheoryAttribute : TheoryAttribute
{
    public LiveBrokerTheoryAttribute()
    {
        if (!LiveBrokerFactAttribute.Enabled)
            Skip = "Set MQTTFORGE_LIVE=1 to dial brokers out on the internet.";
    }
}
