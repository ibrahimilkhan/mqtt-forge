namespace MqttForge.Domain.Models;

// The link that is up: which broker it is to, and what the broker said when it accepted. The
// mirror of BrokerFailure, which answers the same two questions for a link that is down.
// No password: the console never needs it back, and it has no business on the wire twice.
public sealed record BrokerLink(
    string Host,
    int Port,
    string ClientId,
    string? Username,
    bool UseTls,
    DateTimeOffset ConnectedAt,
    bool SessionPresent,
    string? AssignedClientId,
    ushort? ServerKeepAlive);
