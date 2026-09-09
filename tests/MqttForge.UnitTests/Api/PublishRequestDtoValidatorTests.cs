using MqttForge.Api.Contracts;
using MqttForge.Api.Validation;
using Xunit;

namespace MqttForge.UnitTests.Api;

/// <summary>
/// What a message may carry besides its payload.
///
/// Every field here goes on the wire in front of the payload, so each is bounded rather than
/// merely non-null: a broker's maximum packet size is the reader's to spend on the message.
/// </summary>
public class PublishRequestDtoValidatorTests
{
    private readonly PublishRequestDtoValidator _validator = new();

    private static PublishRequestDto Message(
        string? contentType = null,
        string? responseTopic = null,
        string? correlation = null,
        IReadOnlyList<UserPropertyDto>? properties = null) =>
        new("sensors/temp", "23.5", null, 0, false, contentType, responseTopic, correlation, null, properties);

    private bool IsValid(PublishRequestDto dto) => _validator.Validate(dto).IsValid;

    [Fact]
    public void An_ordinary_publish_needs_none_of_it()
    {
        Assert.True(IsValid(Message()));
    }

    [Fact]
    public void Takes_the_five_of_them_together()
    {
        Assert.True(IsValid(Message(
            "application/json",
            "sensors/temp/reply",
            "abc-123",
            [new UserPropertyDto("source", "console")])));
    }

    // A reply goes to one topic. A broker refuses a wildcard here, and some of them refuse it by
    // disconnecting — which takes the console's link down for a typo.
    [Theory]
    [InlineData("sensors/+/reply")]
    [InlineData("sensors/#")]
    public void Refuses_a_response_topic_that_is_a_filter(string topic)
    {
        Assert.False(IsValid(Message(responseTopic: topic)));
    }

    [Fact]
    public void Refuses_a_content_type_carrying_a_control_character()
    {
        Assert.False(IsValid(Message(contentType: "application/json\n")));
    }

    [Fact]
    public void Refuses_a_user_property_with_no_name()
    {
        Assert.False(IsValid(Message(properties: [new UserPropertyDto("", "console")])));
    }

    [Fact]
    public void Refuses_more_properties_than_a_message_has_business_carrying()
    {
        var many = Enumerable.Range(0, 21).Select(i => new UserPropertyDto($"n{i}", "v")).ToList();

        Assert.False(IsValid(Message(properties: many)));
    }

    [Fact]
    public void Refuses_a_content_type_longer_than_a_type()
    {
        Assert.False(IsValid(Message(contentType: new string('a', 256))));
    }
}
