using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.Api.Contracts;

public record SubscribeRequestDto(string TopicFilter, int Qos);

/// <summary>A filter that is up, and whether the console, the rules and the flows each hold it.</summary>
// Flags rather than one owner, because any of them can hold the same filter at once: the console
// asked for '#' and a flow asked for it too, and letting go of one leaves the others standing.
public sealed record ActiveFilterDto(string TopicFilter, bool Console, bool Rules, bool Flows)
{
    public static ActiveFilterDto Of(ActiveFilter filter) =>
        new(filter.Filter,
            filter.Owners.HasFlag(SubscriptionOwner.Console),
            filter.Owners.HasFlag(SubscriptionOwner.Rules),
            filter.Owners.HasFlag(SubscriptionOwner.Flows));
}
