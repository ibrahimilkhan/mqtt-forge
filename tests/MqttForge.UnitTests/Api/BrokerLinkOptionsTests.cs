using Microsoft.Extensions.Configuration;
using MqttForge.Api;

namespace MqttForge.UnitTests.Api;

public class BrokerLinkOptionsTests
{
    private static IConfiguration Config(string? value) =>
        new ConfigurationBuilder()
            .AddInMemoryCollection(value is null ? [] : [new("MqttForge:ConnectOnStart", value)])
            .Build();

    // Off out of the box: the console opens on the Broker panel and waits. The Dockerfile is
    // where the one host with nobody to press Connect says otherwise.
    [Fact]
    public void Nothing_is_dialled_at_start_up_unless_somebody_asks()
    {
        Assert.False(BrokerLinkOptions.Shipped.ConnectOnStart);
        Assert.False(BrokerLinkOptions.From(Config(null)).ConnectOnStart);
    }

    [Theory]
    [InlineData("true")]
    [InlineData("True")]
    public void True_turns_the_start_up_dial_on(string value)
    {
        Assert.True(BrokerLinkOptions.From(Config(value)).ConnectOnStart);
    }

    // The same rule AllowWebhooks follows: a value nobody can read leaves the shipped default
    // standing rather than dialling a broker on a typo.
    [Theory]
    [InlineData("")]
    [InlineData("yes")]
    [InlineData("1")]
    public void An_unreadable_value_leaves_the_shipped_default_standing(string value)
    {
        Assert.False(BrokerLinkOptions.From(Config(value)).ConnectOnStart);
    }
}
