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
    MqttProtocolLevel ProtocolVersion,

    // The saved broker this link was made from, or null: which colour and alert rules apply.
    string? ProfileId = null,

    // The keep-alive this client asked for, which is the one in force when ServerKeepAlive is null.
    ushort? ClientKeepAlive = null)
{
    public static BrokerLinkDto? Of(BrokerLink? link) =>
        link is null
            ? null
            : new BrokerLinkDto(
                link.Host, link.Port, link.ClientId, link.Username, link.UseTls,
                link.ConnectedAt, link.SessionPresent, link.AssignedClientId, link.ServerKeepAlive,
                link.Transport, link.ProtocolVersion, link.ProfileId, link.ClientKeepAlive);
}
