using System.Text.Json;
using System.Text.Json.Serialization;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.Api.Contracts;

// One shape for a failure on the wire, so the console has one thing to learn. Sent with the
// connection state; the 502 body carries only the reason, since a caller mid-request already
// knows which broker it asked for.
public sealed record BrokerFailureDto(
    string Reason, string Host, int Port, string ClientId, bool UseTls,
    MqttTransport Transport, MqttProtocolLevel ProtocolVersion,
    // Only on alertPublishRefused: the rule and the topic, so the console can name them. Left off
    // the wire otherwise rather than sent as null on every other failure.
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] RefusedPublishDto? Publish = null,
    // Only on fellBehind: how fast the broker was sending when the link went.
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] TrafficDto? Traffic = null)
{
    public static BrokerFailureDto? Of(BrokerFailure? failure) =>
        failure is null
            ? null
            : new BrokerFailureDto(
                Name(failure.Reason), failure.Host, failure.Port, failure.ClientId, failure.UseTls,
                failure.Transport, failure.ProtocolVersion,
                failure.RefusedPublish is { } publish ? new RefusedPublishDto(publish.Rule, publish.Topic) : null,
                failure.Traffic is { } traffic
                    ? new TrafficDto((int)Math.Round(traffic.MessagesPerSecond), (int)Math.Round(traffic.KilobytesPerSecond))
                    : null);

    public static string Name(BrokerFailureReason reason) =>
        JsonNamingPolicy.CamelCase.ConvertName(reason.ToString());
}

public sealed record RefusedPublishDto(string Rule, string Topic);

// Whole numbers: the console says "about 450 a second", and a decimal there would claim a
// precision a ten-second average does not have.
public sealed record TrafficDto(int MessagesPerSecond, int KilobytesPerSecond);
