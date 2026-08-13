namespace MqttForge.Api.Validation;

/// <summary>
/// Whether a string is a well-formed MQTT topic filter. An empty segment is legal — 'a//b' has
/// three levels and an empty middle one — so only the wildcards and NUL are policed here.
/// </summary>
public static class TopicFilter
{
    public static bool IsValid(string? filter)
    {
        if (string.IsNullOrEmpty(filter)) return false;
        if (filter.Contains('\0')) return false;

        var segments = filter.Split('/');

        for (var i = 0; i < segments.Length; i++)
        {
            var segment = segments[i];

            // Both wildcards stand alone in their segment; '#' additionally ends the filter.
            if (segment == "#") { if (i != segments.Length - 1) return false; continue; }
            if (segment == "+") continue;
            if (segment.Contains('#') || segment.Contains('+')) return false;
        }

        return true;
    }
}
