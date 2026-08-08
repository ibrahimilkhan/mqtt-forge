using System.Text.Json;
using MQFaker.Domain.Enums;

namespace MQFaker.Api.Contracts;

// One spelling of the reason on the wire, so the console only has one set of names to know
public static class FailureReasonName
{
    public static string? Of(BrokerFailureReason? reason) =>
        reason is null ? null : JsonNamingPolicy.CamelCase.ConvertName(reason.Value.ToString());
}
