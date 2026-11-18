using MqttForge.Domain.Enums;

namespace MqttForge.Domain.Models;

// Why the connection is down, and which broker that is about. The two travel together because
// the console cannot work the second one out: the saved settings are written only after a
// successful connect, so a failed attempt to somewhere else leaves no trace on that side.
//
// The transport and the version travel with it for the same reason. Half the advice worth
// giving depends on them — a broker that answers with something that is not MQTT means "check
// the port" over TCP and "check the path" over a WebSocket — and by the time the console reads
// this, the form that made the attempt may have been edited or closed.
public sealed record BrokerFailure(
    BrokerFailureReason Reason,
    string Host,
    int Port,
    string ClientId,
    bool UseTls,
    MqttTransport Transport = MqttTransport.Tcp,

    // What was asked for, not what was agreed: a failure means nothing was agreed. Auto here
    // says the ladder was walked and every rung refused.
    MqttProtocolLevel ProtocolVersion = MqttProtocolLevel.Auto,

    // Only with AlertPublishRefused: the publish the broker hung up on, so the reader is sent to
    // the rule rather than to the link.
    RefusedPublish? RefusedPublish = null,

    // Only with FellBehind: how fast the broker was sending when the link went, which is the
    // figure a reader narrows their filter against.
    LinkTraffic? Traffic = null);

/// <summary>An alert rule's publish, by the rule's name and the topic it went to.</summary>
public sealed record RefusedPublish(string Rule, string Topic);

/// <summary>
/// What a link was carrying in its last seconds: the rate, and how long before the moment it
/// was read the last message came in — null when none had.
/// </summary>
public sealed record LinkTraffic(double MessagesPerSecond, double KilobytesPerSecond, TimeSpan? SinceLastMessage);
