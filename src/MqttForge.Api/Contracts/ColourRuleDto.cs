using MqttForge.Domain.Models;

namespace MqttForge.Api.Contracts;

/// <summary>
/// One rule on the wire: the filter it covers, the colour its topics are drawn in, and the colour
/// the messages under them are drawn in.
/// </summary>
/// <remarks>
/// <c>BodyColour</c> is absent rather than defaulted. A rule saved before the second colour
/// existed carries no opinion about payloads, and 'no opinion' is not the same request as 'draw
/// them in the topic's colour' — so it is left null and the console goes on drawing them in its
/// own ink.
/// <para>
/// <c>ProfileId</c> is absent for the same reason: a rule for every broker, which is what every
/// rule written before brokers could own them means.
/// </para>
/// </remarks>
public record ColourRuleDto(string Filter, string Colour, string? BodyColour = null, string? ProfileId = null)
{
    public static ColourRuleDto Of(TopicColourRule rule) =>
        new(rule.Filter, rule.Colour, rule.BodyColour, rule.ProfileId);

    public TopicColourRule ToRule() =>
        new(Filter, Colour, BodyColour, string.IsNullOrWhiteSpace(ProfileId) ? null : ProfileId);
}

/// <summary>
/// The whole list, replaced in one PUT. Wrapped in an object rather than sent as a bare array so
/// the payload has somewhere to grow without breaking the shape.
/// </summary>
public record ColourRulesDto(IReadOnlyList<ColourRuleDto> Rules);
