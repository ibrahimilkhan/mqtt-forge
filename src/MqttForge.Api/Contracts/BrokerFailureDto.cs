using System.Text.Json;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.Api.Contracts;

// One shape for a failure on the wire, so the console has one thing to learn. Sent with the
// connection state; the 502 body carries only the reason, since a caller mid-request already
// knows which broker it asked for.
public sealed record BrokerFailureDto(
    string Reason, string Host, int Port, string ClientId, bool UseTls,
    MqttTransport Transport, MqttProtocolLevel ProtocolVersion)
{
    public static BrokerFailureDto? Of(BrokerFailure? failure) =>
        failure is null
            ? null
            : new BrokerFailureDto(
                Name(failure.Reason), failure.Host, failure.Port, failure.ClientId, failure.UseTls,
                failure.Transport, failure.ProtocolVersion);

    public static string Name(BrokerFailureReason reason) =>
        JsonNamingPolicy.CamelCase.ConvertName(reason.ToString());
}
