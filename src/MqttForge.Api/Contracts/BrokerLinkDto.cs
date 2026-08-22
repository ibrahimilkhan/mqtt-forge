using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.Api.Contracts;

// One shape for the live link on the wire, sent with the connection state — the mirror of
// BrokerFailureDto, which says the same things about a link that is down.
public sealed record BrokerLinkDto(
    string Host,
    int Port,
    string ClientId,
    string? Username,
    bool UseTls,
    DateTimeOffset ConnectedAt,
    bool SessionPresent,
    string? AssignedClientId,
    ushort? ServerKeepAlive,
    MqttTransport Transport,

    // The version the broker agreed to, never the one that was asked for. With Auto choosing,
    // those are different questions, and this is the one the console cannot answer for itself.
    MqttProtocolLevel ProtocolVersion)
{
    public static BrokerLinkDto? Of(BrokerLink? link) =>
        link is null
            ? null
            : new BrokerLinkDto(
                link.Host, link.Port, link.ClientId, link.Username, link.UseTls,
                link.ConnectedAt, link.SessionPresent, link.AssignedClientId, link.ServerKeepAlive,
                link.Transport, link.ProtocolVersion);
}
