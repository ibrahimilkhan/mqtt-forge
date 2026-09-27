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
}
