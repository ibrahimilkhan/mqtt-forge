using MQFaker.Domain.Models;

namespace MQFaker.Api.Contracts;

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
    ushort? ServerKeepAlive)
{
    public static BrokerLinkDto? Of(BrokerLink? link) =>
        link is null
            ? null
            : new BrokerLinkDto(
                link.Host, link.Port, link.ClientId, link.Username, link.UseTls,
                link.ConnectedAt, link.SessionPresent, link.AssignedClientId, link.ServerKeepAlive);
}
