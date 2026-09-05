using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.Api.Contracts;

public record SubscribeRequestDto(string TopicFilter, int Qos);

/// <summary>A filter that is up, and whether the console and the rules each hold it.</summary>
// Two flags rather than one owner, because both can hold the same filter at once: the console
// asked for '#' and a rule asked for it too, and letting go of one leaves the other standing.
public sealed record ActiveFilterDto(string TopicFilter, bool Console, bool Rules)
{
    public static ActiveFilterDto Of(ActiveFilter filter) =>
        new(filter.Filter,
            filter.Owners.HasFlag(SubscriptionOwner.Console),
            filter.Owners.HasFlag(SubscriptionOwner.Rules));
}
