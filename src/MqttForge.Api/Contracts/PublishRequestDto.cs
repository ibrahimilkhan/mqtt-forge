using System.Text;
using MqttForge.Domain.Models;

namespace MqttForge.Api.Contracts;

/// <summary>One name and one value, carried alongside a message on an MQTT 5 link.</summary>
public record UserPropertyDto(string Name, string Value);

/// <param name="ContentType">A MIME type for the payload, for a reader at the other end.</param>
/// <param name="ResponseTopic">Where a reply should be published.</param>
/// <param name="CorrelationData">Sent back with the reply. Text, encoded UTF-8.</param>
/// <param name="MessageExpiryInterval">Seconds the broker may hold the message for.</param>
/// <param name="UserProperties">Names and values of the caller's own.</param>
public record PublishRequestDto(
    string Topic,
    string Payload,
    string? PayloadEncoding,
    int Qos,
    bool Retain,
    string? ContentType = null,
    string? ResponseTopic = null,
    string? CorrelationData = null,
    uint? MessageExpiryInterval = null,
    IReadOnlyList<UserPropertyDto>? UserProperties = null)
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
        Retain,
        Properties());

    /// <summary>
    /// The MQTT 5 part of the request, or null where the caller asked for none of it.
    ///
    /// Null rather than an object of nulls, so the publisher has one question to ask rather than
    /// five — and so an ordinary publish over a 3.1.1 link carries nothing that would have to be
    /// refused. An empty string is treated as absent throughout: a field a reader opened and left
    /// blank is a field they did not fill in, and sending `contentType: ""` says something about
    /// the payload that is not true.
    /// </summary>
    private PublishProperties? Properties()
    {
        var properties = new PublishProperties(
            Said(ContentType),
            Said(ResponseTopic),
            Said(CorrelationData) is { } correlation ? Encoding.UTF8.GetBytes(correlation) : null,
            MessageExpiryInterval,
            UserProperties
                ?.Where(one => !string.IsNullOrEmpty(one.Name))
                .Select(one => new UserProperty(one.Name, one.Value ?? string.Empty))
                .ToList());

        return properties.Any ? properties : null;
    }

    private static string? Said(string? value) => string.IsNullOrEmpty(value) ? null : value;
}
