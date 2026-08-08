using MQFaker.Domain.Enums;

namespace MQFaker.Domain.Models;

// Why the connection is down, and which broker that is about. The two travel together because
// the console cannot work the second one out: the saved settings are written only after a
// successful connect, so a failed attempt to somewhere else leaves no trace on that side.
public sealed record BrokerFailure(
    BrokerFailureReason Reason, string Host, int Port, string ClientId, bool UseTls);
