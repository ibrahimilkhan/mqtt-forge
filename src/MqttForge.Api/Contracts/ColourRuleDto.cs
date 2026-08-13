using MqttForge.Domain.Models;

namespace MqttForge.Api.Contracts;

/// <summary>One rule on the wire: the filter it covers and the colour its topics are drawn in.</summary>
public record ColourRuleDto(string Filter, string Colour)
{
    public static ColourRuleDto Of(TopicColourRule rule) => new(rule.Filter, rule.Colour);

    public TopicColourRule ToRule() => new(Filter, Colour);
}

/// <summary>
/// The whole list, replaced in one PUT. Wrapped in an object rather than sent as a bare array so
/// the payload has somewhere to grow without breaking the shape.
/// </summary>
public record ColourRulesDto(IReadOnlyList<ColourRuleDto> Rules);
