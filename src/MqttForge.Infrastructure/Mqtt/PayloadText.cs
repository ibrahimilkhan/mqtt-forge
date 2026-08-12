using System.Buffers;
using System.Text;
using System.Text.Unicode;

namespace MqttForge.Infrastructure.Mqtt;

/// <summary>
/// Decides, once and where the bytes still exist, how a payload can be carried as a JSON string.
///
/// Text is the common case by far and stays readable on the wire, so only bytes that are not
/// valid UTF-8 pay for base64 — a '#' subscription on a busy broker would otherwise carry a
/// third more bytes for nothing.
/// </summary>
public static class PayloadText
{
    public const string Text = "text";
    public const string Base64 = "base64";

    public static (string Payload, string Encoding) Describe(in ReadOnlySequence<byte> payload) =>
        payload.IsSingleSegment ? Describe(payload.First.Span) : Describe(payload.ToArray());

    private static (string Payload, string Encoding) Describe(ReadOnlySpan<byte> bytes) =>
        Utf8.IsValid(bytes)
            ? (Encoding.UTF8.GetString(bytes), Text)
            : (Convert.ToBase64String(bytes), Base64);
}
