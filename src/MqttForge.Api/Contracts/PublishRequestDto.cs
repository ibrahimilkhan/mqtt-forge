using System.Text;
using MqttForge.Domain.Models;

namespace MqttForge.Api.Contracts;

public record PublishRequestDto(string Topic, string Payload, string? PayloadEncoding, int Qos, bool Retain)
{
    public const string TextEncoding = "text";
    public const string Base64Encoding = "base64";

    /// Text is the default so a client that never heard of the field keeps working. Validation
    /// has already run by the time this is called, so the base64 here cannot be unparsable.
    public PublishRequest ToRequest() => new(
        Topic,
        PayloadEncoding == Base64Encoding
            ? Convert.FromBase64String(Payload)
            : Encoding.UTF8.GetBytes(Payload),
        Qos,
        Retain);
}
