using System.Buffers;
using System.Text;
using System.Text.Unicode;

namespace MqttForge.Infrastructure.Mqtt;

/// <summary>
/// Decides, once and where the bytes still exist, how a payload can be carried as a JSON string.
///
/// Text is the common case by far and stays readable on the wire, so only bytes that are not
/// text pay for base64 — a '#' subscription on a busy broker would otherwise carry a third more
/// bytes for nothing. Text means valid UTF-8 that also carries no C0 control byte other than
/// tab, CR or LF: real text never carries those, but a small-valued binary payload (a Modbus
/// register block, say) can be valid UTF-8 while still being binary.
/// </summary>
public static class PayloadText
{
    public const string Text = "text";
    public const string Base64 = "base64";

    public static (string Payload, string Encoding) Describe(in ReadOnlySequence<byte> payload) =>
        payload.IsSingleSegment ? Describe(payload.First.Span) : Describe(payload.ToArray());

    private static (string Payload, string Encoding) Describe(ReadOnlySpan<byte> bytes) =>
        Utf8.IsValid(bytes) && !HasControlBytes(bytes)
            ? (Encoding.UTF8.GetString(bytes), Text)
            : (Convert.ToBase64String(bytes), Base64);

    // C0 controls other than tab/CR/LF: no text payload carries them, every binary one might.
    private static bool HasControlBytes(ReadOnlySpan<byte> bytes)
    {
        foreach (var b in bytes)
            if (b < 0x20 && b is not ((byte)'\t' or (byte)'\r' or (byte)'\n')) return true;

        return false;
    }
}
