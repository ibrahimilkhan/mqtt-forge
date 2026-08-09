using MqttForge.Domain.Models;
using Xunit;

namespace MqttForge.UnitTests.Domain;

public class BrokerConnectionSettingsTests
{
    [Fact]
    public void Records_with_same_values_are_equal()
    {
        var a = new BrokerConnectionSettings("localhost", 1883, "id", null, null, false);
        var b = new BrokerConnectionSettings("localhost", 1883, "id", null, null, false);

        Assert.Equal(a, b);
    }
}
