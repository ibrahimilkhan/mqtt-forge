using MqttForge.Domain;

namespace MqttForge.Api.Validation;

/// <summary>
/// Whether a string is a well-formed MQTT topic filter. An empty segment is legal — 'a//b' has
/// three levels and an empty middle one — so only the wildcards, NUL and the length are policed here.
/// </summary>
// The rule itself moved to TopicFilterMatch.IsValidFilter when the flow compiler needed it from
// Application. This name stays because every validator in this folder already asks it.
public static class TopicFilter
{
    public static bool IsValid(string? filter) => TopicFilterMatch.IsValidFilter(filter);

    /// <summary>Whether MQTT could carry the filter at all.</summary>
    // Asked first, and the rule after it not asked at all when this fails (CascadeMode.Stop). That
    // rule quotes the filter back, which is how whoever wrote it finds the one at fault among a
    // hundred — and quoted, one too long to carry puts up to 65 KB into the error and into the log,
    // and still does not say what is wrong with it. It is said instead in the sentence the flows'
    // MQTT in hears.
    public static bool FitsMqtt(string? filter) => !TopicFilterMatch.IsTooLong(filter);

    /// <summary>What is said of a filter that does not.</summary>
    public const string TooLong = TopicFilterMatch.FilterTooLong;
}
