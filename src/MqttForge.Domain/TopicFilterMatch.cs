namespace MqttForge.Domain;

/// <summary>
/// Whether an MQTT topic filter covers a topic. The server's copy of
/// <c>web/src/lib/topicMatch.ts</c>.
/// </summary>
// It sits at the root of Domain rather than under Models because it is not a model — it is one
// rule about two strings, and Api/Validation/TopicFilter.cs, which only says whether a filter is
// well formed, is deliberately not the place for it: validation is an Api concern and matching is
// now on the message path.
//
// A second implementation of the browser's rule, and named as one. The alternative was to let the
// engine ask the broker — subscribe and take whatever arrives — and that is not available: one
// connection carries every rule's subscription at once, so a message that arrives has to be
// handed to the rules whose filters cover it and to no others.
//
// The two implementations must agree on every input, because the console draws the tree and the
// log from one of them and the engine fires from the other. A topic the reader can see under a
// filter chip and a rule with that same filter that never fires would be a bug with nowhere on
// screen to show itself.
public static class TopicFilterMatch
{
    /// <summary>Whether <paramref name="filter"/> covers <paramref name="topic"/>.</summary>
    // Written over the strings themselves rather than over two arrays from Split, and that is
    // worth the extra dozen lines: this runs once per rule per arrival — a hundred rules at fifty
    // messages a second is five thousand calls a second — and Split would hand the collector two
    // arrays and every segment as its own string for each of them, all of it dead again
    // immediately. The browser can afford Split; a receive path that must not stall the broker
    // connection should not pay for it.
    //
    // The shape below is topicMatch.ts's loop with the two array indices turned into two
    // positions: 'the filter has run out' is a null slash, and 'i >= segments.length' is
    // topicDone. Splitting on '/' always yields at least one segment, even for an empty string,
    // and that is why topicDone is a flag rather than a comparison — an empty topic has one empty
    // segment to be matched against, not none.
    public static bool Matches(string filter, string topic)
    {
        // An empty filter matches nothing, exactly as the browser's `if (!filter) return false`
        // does. It is not "matches everything with no constraints"; it is a filter that was never
        // written, and a rule carrying one should be silent rather than deafening.
        if (string.IsNullOrEmpty(filter)) return false;

        var f = 0;
        var t = 0;
        var topicDone = false;

        while (true)
        {
            var fEnd = filter.IndexOf('/', f);
            var part = fEnd < 0 ? filter.AsSpan(f) : filter.AsSpan(f, fEnd - f);

            // '#' covers the rest of the topic and its own level with it, which is why the answer
            // comes before the topic is looked at: 'sensors/#' matches 'sensors' with nothing
            // left to compare. It also means a '#' in the middle of a filter swallows everything
            // after it. That filter cannot be saved — the validator refuses it — and the browser
            // behaves the same way, so it is left as it is rather than given a second rule here.
            if (part.Length == 1 && part[0] == '#') return true;

            // The filter still has a segment and the topic has none: 'sensors/room/temp' cannot
            // match 'sensors/room'.
            if (topicDone) return false;

            var tEnd = topic.IndexOf('/', t);
            var segment = tEnd < 0 ? topic.AsSpan(t) : topic.AsSpan(t, tEnd - t);

            // '+' stands for one level and an empty level is still a level, so 'a/+/b' covers
            // 'a//b'. Ordinal comparison, and nothing else would do: topics are bytes on a wire
            // and 'Temp' is not 'temp' to a broker.
            if (!(part.Length == 1 && part[0] == '+') && !part.SequenceEqual(segment)) return false;

            // The filter has run out. This is `parts.length === segments.length`: the topic has
            // to have run out on the same segment, so 'sensors' does not cover 'sensors/room'.
            if (fEnd < 0) return tEnd < 0;

            f = fEnd + 1;

            if (tEnd < 0) topicDone = true;
            else t = tEnd + 1;
        }
    }

    /// <summary>Whether the filter carries a wildcard, and so names a set rather than a topic.</summary>
    // The silence condition is the caller that matters. A filter with no wildcard in it *is* a
    // topic name, so a silence rule over one can fire for a device that has never said anything
    // at all — which is the alert people most want and the only case where the engine can know
    // that a topic ought to exist. With a wildcard it can only speak about topics it has already
    // seen, and the panel says so underneath the rule.
    //
    // A plain search rather than a per-segment test: a filter that reaches here has been through
    // TopicFilter.IsValid, so a '+' or '#' loose inside a segment cannot occur — and if one ever
    // did, calling it a wildcard errs towards saying nothing instead of inventing a topic name
    // out of a malformed filter and then reporting it silent for ever.
    public static bool HasWildcard(string filter) => filter.AsSpan().IndexOfAny('+', '#') >= 0;
}
