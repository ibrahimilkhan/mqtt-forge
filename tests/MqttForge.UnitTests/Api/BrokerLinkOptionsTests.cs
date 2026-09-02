using Microsoft.Extensions.Configuration;
using MqttForge.Api;

namespace MqttForge.UnitTests.Api;

public class BrokerLinkOptionsTests
{
    private static IConfiguration Config(string? value) =>
        new ConfigurationBuilder()
            .AddInMemoryCollection(value is null ? [] : [new("MqttForge:ConnectOnStart", value)])
            .Build();

    [Fact]
    public void A_server_dials_at_start_up_unless_told_otherwise()
    {
        Assert.True(BrokerLinkOptions.Shipped.ConnectOnStart);
        Assert.True(BrokerLinkOptions.From(Config(null)).ConnectOnStart);
    }

    [Theory]
    [InlineData("false")]
    [InlineData("False")]
    public void False_turns_the_start_up_dial_off(string value)
    {
        Assert.False(BrokerLinkOptions.From(Config(value)).ConnectOnStart);
    }

    // The same rule AllowWebhooks follows: a value nobody can read leaves the shipped default
    // standing rather than quietly turning a container's rules off.
    [Theory]
    [InlineData("")]
    [InlineData("no")]
    [InlineData("0")]
    public void An_unreadable_value_leaves_the_shipped_default_standing(string value)
    {
        Assert.True(BrokerLinkOptions.From(Config(value)).ConnectOnStart);
    }
}
