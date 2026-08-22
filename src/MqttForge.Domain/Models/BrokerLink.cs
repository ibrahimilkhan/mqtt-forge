using MqttForge.Domain.Enums;

namespace MqttForge.Domain.Models;

// The link that is up: which broker it is to, how it was reached, and what the broker said when
// it accepted. The mirror of BrokerFailure, which answers the same questions for a link that is
// down. No password: the console never needs it back, and it has no business on the wire twice.
public sealed record BrokerLink(
    string Host,
    int Port,
    string ClientId,
    string? Username,
    bool UseTls,
    DateTimeOffset ConnectedAt,
    bool SessionPresent,
    string? AssignedClientId,
    ushort? ServerKeepAlive,

    // How the packets got there, and which MQTT the broker agreed to. Both are worth a row of
    // their own: with Auto doing the choosing, the version in the form is a request and this is
    // the answer, and a reader debugging a broker needs to know which one they actually got.
    MqttTransport Transport = MqttTransport.Tcp,
    MqttProtocolLevel ProtocolVersion = MqttProtocolLevel.V500);
