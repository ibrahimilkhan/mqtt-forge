namespace MqttForge.Domain.Models;

// The generated record equality compares Payload by reference (byte[] has no value equality),
// so two requests with identical bytes are unequal. Nothing depends on this today.
public record PublishRequest(
    string Topic,
    byte[] Payload,
    int Qos,
    bool Retain,
    PublishProperties? Properties = null);

/// <summary>One name and one value, travelling with a message and meaning nothing to the broker.</summary>
public record UserProperty(string Name, string Value);

/// <summary>
/// What MQTT 5 lets a message carry besides its payload.
///
/// Every one of these is a property of the message rather than of the connection, so they are
/// part of the request and not of the client's options. All of them are optional and most
/// messages carry none: this is null on a request that asked for nothing, and any field of it may
/// be null on a request that asked for one thing.
/// </summary>
// 3.1.1 has no room for any of it — not an empty room, no room — so a broker spoken to in 3.1.1
// is not sent a message carrying these. See MqttnetPublisher, which refuses rather than dropping
// them: a correlation id quietly left off a request is a reply that never comes back, and the
// reader would be looking at the wrong end of it.
/// <param name="ContentType">What the payload is, as a MIME type — application/json, text/plain.</param>
/// <param name="ResponseTopic">Where a reply to this message should be published.</param>
/// <param name="CorrelationData">Handed back with the reply, so a caller knows whose reply it is.</param>
/// <param name="MessageExpiryInterval">Seconds the broker may hold this for a subscriber that is not there yet.</param>
/// <param name="UserProperties">Whatever else the two ends have agreed to send each other.</param>
public record PublishProperties(
    string? ContentType = null,
    string? ResponseTopic = null,
    byte[]? CorrelationData = null,
    uint? MessageExpiryInterval = null,
    IReadOnlyList<UserProperty>? UserProperties = null)
{
    /// <summary>Whether anything here would actually go on the wire.</summary>
    public bool Any =>
        ContentType is not null
        || ResponseTopic is not null
        || CorrelationData is not null
        || MessageExpiryInterval is not null
        || UserProperties is { Count: > 0 };
}
