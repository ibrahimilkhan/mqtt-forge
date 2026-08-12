using System.Text;
using MqttForge.Api.Contracts;

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
}
