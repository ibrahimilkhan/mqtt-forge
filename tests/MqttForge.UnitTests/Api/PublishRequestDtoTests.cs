using System.Text;
using MqttForge.Api.Contracts;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Api;

public class PublishRequestDtoTests
{
    [Fact]
    public void Missing_encoding_is_read_as_utf8_text()
    {
        var dto = new PublishRequestDto("sensors/temp", "23.5", null, 0, false);

        Assert.Equal("23.5"u8.ToArray(), dto.ToRequest().Payload);
    }

    [Fact]
    public void Text_encoding_is_utf8()
    {
        var dto = new PublishRequestDto("sensors/temp", "ölçüm", PublishRequestDto.TextEncoding, 0, false);

        Assert.Equal(Encoding.UTF8.GetBytes("ölçüm"), dto.ToRequest().Payload);
    }

    [Fact]
    public void Base64_encoding_is_decoded_to_the_bytes_it_carries()
    {
        // 01 A4 FF. The last byte is not valid UTF-8 on its own, which is the whole point:
        // no text field can express it.
        var dto = new PublishRequestDto("device/cmd", "AaT/", PublishRequestDto.Base64Encoding, 0, false);

        Assert.Equal(new byte[] { 0x01, 0xA4, 0xFF }, dto.ToRequest().Payload);
    }

    [Fact]
    public void Empty_payload_stays_empty()
    {
        var dto = new PublishRequestDto("sensors/temp", "", null, 0, true);

        Assert.Empty(dto.ToRequest().Payload);
    }

    [Fact]
    public void Topic_qos_and_retain_ride_through_untouched()
    {
        var dto = new PublishRequestDto("sensors/temp", "x", null, 2, true);

        var request = dto.ToRequest();

        Assert.Equal("sensors/temp", request.Topic);
        Assert.Equal(2, request.Qos);
        Assert.True(request.Retain);
    }

    [Fact]
    public void A_message_that_asked_for_nothing_carries_no_properties()
    {
        var dto = new PublishRequestDto("sensors/temp", "23.5", null, 0, false);

        Assert.Null(dto.ToRequest().Properties);
    }

    // A field opened and left blank is a field nobody filled in. Sending `contentType: ""` says
    // something about the payload that is not true, and a broker has to carry it either way.
    [Fact]
    public void Fields_left_blank_are_absent_rather_than_empty()
    {
        var dto = new PublishRequestDto("sensors/temp", "23.5", null, 0, false,
            ContentType: "", ResponseTopic: "", CorrelationData: "", UserProperties: []);

        Assert.Null(dto.ToRequest().Properties);
    }

    [Fact]
    public void What_mqtt5_lets_a_message_carry_reaches_the_request()
    {
        var dto = new PublishRequestDto("sensors/temp", "23.5", null, 0, false,
            ContentType: "application/json",
            ResponseTopic: "sensors/temp/reply",
            CorrelationData: "abc-123",
            MessageExpiryInterval: 60,
            UserProperties: [new UserPropertyDto("source", "console")]);

        var properties = dto.ToRequest().Properties;

        Assert.NotNull(properties);
        Assert.Equal("application/json", properties.ContentType);
        Assert.Equal("sensors/temp/reply", properties.ResponseTopic);
        Assert.Equal("abc-123"u8.ToArray(), properties.CorrelationData);
        Assert.Equal(60u, properties.MessageExpiryInterval);
        Assert.Equal([new UserProperty("source", "console")], properties.UserProperties);
    }

    // The form sends a line at a time and a half-typed line has a value and no name yet.
    [Fact]
    public void A_user_property_with_no_name_is_dropped()
    {
        var dto = new PublishRequestDto("sensors/temp", "x", null, 0, false,
            UserProperties: [new UserPropertyDto("", "orphan"), new UserPropertyDto("kept", "yes")]);

        Assert.Equal([new UserProperty("kept", "yes")], dto.ToRequest().Properties!.UserProperties);
    }
}
