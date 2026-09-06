namespace MqttForge.Domain;

/// <summary>
/// Whether one topic filter covers another — that is, whether every topic the second would bring
/// in is already brought in by the first.
/// </summary>
// Written for the one thing a broker will not do for us: it takes each of a client's filters as
// its own standing order and sends a copy of a message per filter that matches it. A console
// listening to '#' that also holds 'plant/#' — the default box ticked and one chip added, or the
// default box ticked and any alert rule saved — is handed every message under plant twice, and
// counts, plots, rates and statistics all double for exactly the part of the tree somebody cared
// enough about to name.
//
// The MQTT specification says this is correct behaviour ("if a Client subscribes with overlapping
// Subscriptions the Server MUST send the message to the Client for each matching Subscription"),
// so the answer is not to ask the broker to behave differently. It is not to ask twice.
//
// Coverage rather than equality, because the overlap that matters is not two identical filters —
// the subscriber already holds those once, under one key, with two owners. It is a narrow filter
// arriving under a wide one that is already up.
public static class TopicFilterCover
{
    /// <summary>
    /// Whether <paramref name="wide"/> already brings in everything <paramref name="narrow"/>
    /// would. A filter covers itself.
    /// </summary>
    // The walk is topicMatch's, with one difference that is the whole of the problem: the right
    // hand side is a filter and not a topic, so its own wildcards have to be answered rather than
    // compared. '+' on the left covers one level of anything except a '#', which is not one level;
    // '#' on the left covers whatever is left, including a '#'; and a literal on the left covers
    // only the same literal, since a '+' or '#' on the right stands for topics the literal does
    // not.
    public static bool Covers(string wide, string narrow)
    {
        if (string.IsNullOrEmpty(wide) || string.IsNullOrEmpty(narrow)) return false;

        // A wildcard at the head of a filter cannot reach a topic beginning with '$', so '#' does
        // not cover '$SYS/#' — the reason the console asks for the broker's statistics in a
        // subscription of their own. Left here rather than in the walk because it is a rule about
        // the first level only.
        if (Wildcard(Head(wide)) && Head(narrow).StartsWith('$')) return false;

        var w = 0;
        var n = 0;

        while (true)
        {
            var wEnd = wide.IndexOf('/', w);
            var wide_ = wEnd < 0 ? wide.AsSpan(w) : wide.AsSpan(w, wEnd - w);

            // Everything from here down, whatever the other side has left to say.
            if (Is(wide_, '#')) return true;

            var nEnd = narrow.IndexOf('/', n);
            var narrow_ = nEnd < 0 ? narrow.AsSpan(n) : narrow.AsSpan(n, nEnd - n);

            // The other side reaches deeper than this one can follow: 'a/+' does not cover 'a/#',
            // which brings in 'a/b/c' as well.
            if (Is(narrow_, '#')) return false;

            // '+' stands for one level and takes any single level with it; a literal takes only
            // itself, so a '+' on the other side is a set it does not hold.
            if (!Is(wide_, '+') && !wide_.SequenceEqual(narrow_)) return false;

            // Both ran out together: the same shape, level for level.
            if (wEnd < 0 && nEnd < 0) return true;

            // The other side has run out and this one has not. Only a '#' still covers it, and it
            // does: '#' stands for its own level as well as the ones under it, so 'plant/#' brings
            // in the topic 'plant' — which is the whole of what the filter 'plant' brings in.
            if (nEnd < 0) return wide.AsSpan(wEnd + 1).SequenceEqual("#");

            // This side has run out and the other has not: 'a/b' does not cover 'a/b/c'.
            if (wEnd < 0) return false;

            w = wEnd + 1;
            n = nEnd + 1;
        }
    }

    private static bool Is(ReadOnlySpan<char> part, char what) => part.Length == 1 && part[0] == what;

    private static ReadOnlySpan<char> Head(string filter)
    {
        var end = filter.IndexOf('/');
        return end < 0 ? filter.AsSpan() : filter.AsSpan(0, end);
    }

    private static bool Wildcard(ReadOnlySpan<char> part) => Is(part, '#') || Is(part, '+');
}
