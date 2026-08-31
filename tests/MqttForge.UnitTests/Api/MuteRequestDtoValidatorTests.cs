using MqttForge.Api.Contracts;
using MqttForge.Api.Validation;
using MqttForge.Application.Alerts;
using Xunit;

namespace MqttForge.UnitTests.Api;

/// <summary>
/// Silencing one pair. The one bound worth arguing about is the day: past it, muting is disabling
/// the rule without ever saying the word 'disabled' — so the editor stops there and says so, and
/// somebody who really means it turns the rule off where the panel can show it turned off.
/// </summary>
public class MuteRequestDtoValidatorTests
{
    private readonly MuteRequestDtoValidator _validator = new();

    private bool IsValid(string ruleId, string topic, int minutes) =>
        _validator.Validate(new MuteRequestDto(ruleId, topic, minutes)).IsValid;

    [Fact]
    public void Accepts_a_plain_mute()
    {
        Assert.True(IsValid("6f1d", "plant/boiler/temp", 30));
    }

    // Zero is not a mute, it is the undo — the panel's "Geri al" button sends exactly this.
    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(1440)]
    public void Accepts_the_minutes_at_the_edges(int minutes)
    {
        Assert.True(IsValid("6f1d", "plant/boiler/temp", minutes));
        Assert.Equal(1440, AlertEngineCore.MaxMuteMinutes);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(1441)]
    public void Refuses_minutes_outside_the_day(int minutes)
    {
        Assert.False(IsValid("6f1d", "plant/boiler/temp", minutes));
    }

    [Fact]
    public void Refuses_an_empty_rule_id()
    {
        Assert.False(IsValid("", "plant/boiler/temp", 30));
    }

    [Fact]
    public void Refuses_an_empty_topic()
    {
        Assert.False(IsValid("6f1d", "", 30));
    }

    // A mute addresses one pair, and a pair holds a topic — the concrete one an alarm is ringing
    // on. A filter here would look like it silenced twenty boilers and would silence none of them,
    // because nothing downstream ever matches a mute against anything.
    [Theory]
    [InlineData("plant/+/temp")]
    [InlineData("plant/#")]
    [InlineData("plant/\0/temp")]
    public void Refuses_a_topic_that_is_really_a_filter(string topic)
    {
        Assert.False(IsValid("6f1d", topic, 30));
    }
}
