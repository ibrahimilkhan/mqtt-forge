namespace MqttForge.Application.Alerts;

/// <summary>
/// Two questions about the tree the engine publishes into: does a filter reach into it, and does a
/// publish topic stay inside it.
/// </summary>
// A '{topic}' here and a '{topic}' in Infrastructure's MqttAlertDispatcher are the same contract
// and cannot be the same constant, because Infrastructure does not reference Api. The dispatcher's
// own test has to pin this literal too: a validator accepting '{topic}' while a dispatcher expanded
// '${topic}' would publish every alert to a topic with a brace in it, and nothing would say so.
public static class AlertTopicPrefix
{
    /// <summary>What a publish topic writes to stand for the topic that fired the alarm.</summary>
    public const string Placeholder = "{topic}";

    public static string Expand(string topic, string messageTopic) =>
        topic.Replace(Placeholder, messageTopic, StringComparison.Ordinal);

    /// <summary>Whether a publish topic lands under <paramref name="prefix"/> once it is expanded.</summary>
    // Written as a real expansion rather than as a StartsWith on the template, because the rule
    // the spec states is about the expanded topic and the two only look the same until somebody
    // writes '{topic}/alarm' — which passes any test of the literal that ignores where the
    // placeholder sits, and at runtime publishes into the plant.
    //
    // The probe is NUL, the one character MQTT forbids in a topic name, and it is chosen for
    // exactly that reason: no configured prefix can begin with it, so the only way an expanded
    // topic can start with the prefix is for the prefix to be written in front of the placeholder.
    // Any ordinary probe string would be a prefix somebody could configure and then be wrong about.
    public static bool Inside(string topic, string prefix) =>
        Expand(topic, "\0").StartsWith(prefix, StringComparison.Ordinal);

    /// <summary>Whether a subscription filter reaches into the tree under <paramref name="prefix"/>.</summary>
    // Structural rather than 'match it against a sample topic', because a sample only ever answers
    // for its own depth: 'mqttforge/alerts/+' covers one level under the prefix and 'mqttforge/#'
    // covers all of them, and no single probe topic is matched by both.
    //
    // A filter that runs out at or above the prefix is not covering it: 'mqttforge/alerts' names
    // the level above the tree, which is not in it — the engine's own guard is a StartsWith on a
    // prefix that ends in '/'.
    public static bool Covers(string filter, string prefix)
    {
        var levels = prefix.TrimEnd('/').Split('/');
        var parts = filter.Split('/');

        for (var i = 0; i < levels.Length; i++)
        {
            if (i >= parts.Length) return false;

            // '#' takes this level and everything under it, prefix included.
            if (parts[i] == "#") return true;
            if (parts[i] != "+" && parts[i] != levels[i]) return false;
        }

        // Every level of the prefix matched, and there is at least one level left over — which is
        // where the rule id goes, so this filter covers real published alerts.
        return parts.Length > levels.Length;
    }
}
