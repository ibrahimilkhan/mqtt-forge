using System.Buffers;
using System.Text;
using MqttForge.Infrastructure.Mqtt;

namespace MqttForge.UnitTests.Infrastructure;

public class PayloadTextTests
{
    [Fact]
    public void Ascii_is_carried_as_text()
    {
        var (payload, encoding) = PayloadText.Describe(Sequence("23.5"u8.ToArray()));

        Assert.Equal("23.5", payload);
        Assert.Equal(PayloadText.Text, encoding);
    }

    [Fact]
    public void Multi_byte_utf8_is_still_text()
    {
        var bytes = Encoding.UTF8.GetBytes("ölçüm · 23,5");

        var (payload, encoding) = PayloadText.Describe(Sequence(bytes));

        Assert.Equal("ölçüm · 23,5", payload);
        Assert.Equal(PayloadText.Text, encoding);
    }

    [Fact]
    public void Empty_payload_is_empty_text()
    {
        var (payload, encoding) = PayloadText.Describe(Sequence([]));

        Assert.Equal("", payload);
        Assert.Equal(PayloadText.Text, encoding);
    }

    [Fact]
    public void Bytes_that_are_not_utf8_are_carried_as_base64()
    {
        var (payload, encoding) = PayloadText.Describe(Sequence([0x01, 0xA4, 0xFF]));

        Assert.Equal(PayloadText.Base64, encoding);
        Assert.Equal(new byte[] { 0x01, 0xA4, 0xFF }, Convert.FromBase64String(payload));
    }

    [Fact]
    public void A_truncated_multi_byte_character_is_binary_not_text()
    {
        // First byte of a two-byte sequence with nothing after it. A UTF-8 decode would
        // silently turn this into U+FFFD and lose the byte.
        var (payload, encoding) = PayloadText.Describe(Sequence([0xC3]));

        Assert.Equal(PayloadText.Base64, encoding);
        Assert.Equal(new byte[] { 0xC3 }, Convert.FromBase64String(payload));
    }

    [Fact]
    public void A_payload_split_across_segments_reads_the_same_as_one_block()
    {
        var bytes = Encoding.UTF8.GetBytes("ölçüm");

        var (payload, encoding) = PayloadText.Describe(Split(bytes, 2));

        Assert.Equal("ölçüm", payload);
        Assert.Equal(PayloadText.Text, encoding);
    }

    private static ReadOnlySequence<byte> Sequence(byte[] bytes) => new(bytes);

    private static ReadOnlySequence<byte> Split(byte[] bytes, int at)
    {
        var first = new Segment(bytes.AsMemory(0, at));
        var second = first.Append(bytes.AsMemory(at));
        return new ReadOnlySequence<byte>(first, 0, second, second.Memory.Length);
    }

    private sealed class Segment : ReadOnlySequenceSegment<byte>
    {
        public Segment(ReadOnlyMemory<byte> memory) => Memory = memory;

        public Segment Append(ReadOnlyMemory<byte> memory)
        {
            var next = new Segment(memory) { RunningIndex = RunningIndex + Memory.Length };
            Next = next;
            return next;
        }
    }
}
