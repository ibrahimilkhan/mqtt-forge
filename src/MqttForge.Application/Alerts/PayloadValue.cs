using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace MqttForge.Application.Alerts;

/// <summary>
/// The text a rule is about — the body, or one field out of it — and whether that text is a
/// number. The server's copy of the field walking in <c>web/src/lib/series.ts</c> and of
/// <c>asReading</c> in <c>web/src/lib/number.ts</c>.
/// </summary>
// Both halves must answer what the console answers, and the reason is the same one as for
// TopicFilterMatch: the reader writes a rule after looking at a chart. A field the chart offered
// as a chip has to be a field a rule can read, and a body the chart drew as a line has to be a
// body a threshold can compare. Where the two disagree, the disagreement shows up as a rule that
// quietly never fires, and the panel's skipped counter is the only trace of it.
public static class PayloadValue
{
    /// <summary>
    /// How deep a path may go. The same ceiling series.ts enumerates bodies with (MAX_DEPTH).
    /// </summary>
    // Six is not arbitrary here either: it is the depth the chart's field list stops at, so a
    // seventh level is a level no chip ever offered. It is also the bound on the work one
    // arrival can cause — a path of a thousand dots costs six lookups and then a refusal.
    public const int MaxDepth = 6;

    // Character for character the READING pattern of number.ts, with one deliberate difference:
    // [0-9] where the browser writes \d. In .NET \d matches every Unicode decimal digit, so a
    // body of Arabic-Indic digits would pass a test the browser fails, and the two would disagree
    // about whether a topic is sending readings at all.
    //
    // Compiled, because this runs once per arrival per rule and the pattern is fixed. It has no
    // backtracking to speak of — one alternation of digit runs — so it needs none of the
    // protection CompiledPatterns gives a user's own regex.
    private static readonly Regex ReadingPattern =
        new(@"^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);

    /// <summary>
    /// The text a rule is about: the body itself, or what the path found in it.
    /// </summary>
    // False means 'the topic did not say', and the caller turns that into EvalContext.Text = null,
    // which every condition treats as a skip rather than as a falsehood. That distinction is the
    // whole reason this returns a bool instead of a string?: a rule reading '< 10' must not fire
    // on every message that happens not to carry the field, and a pattern rule with negate set
    // must not treat an absent field as 'did not match'.
    public static bool TryExtract(string payload, string? field, out string? text)
    {
        // No field is not a missing field. The rule is about the body, which is what a topic
        // sending a bare '23.5' carries, and the body is always there — even when it is empty,
        // even when it is prose.
        if (string.IsNullOrEmpty(field))
        {
            text = payload;
            return true;
        }

        text = null;

        // series.ts's parse() in three lines. A body that does not open as an object or an array
        // is not a document, and this is not an optimisation: it is the difference between 'the
        // path is not in there' and 'there is nothing to look in'. Both answer false, so the
        // cheap test comes first and JsonDocument never sees a plain reading — which is the
        // common case on a topic somebody has pointed a field rule at by mistake.
        var body = payload.AsMemory().Trim();
        if (body.Length == 0) return false;

        var opening = body.Span[0];
        if (opening != '{' && opening != '[') return false;

        try
        {
            // Parsed from the trimmed memory, so the body is not copied into a second string
            // first. JsonDocument is pooled and disposed here rather than kept: the engine holds
            // readings, not payloads, and the extracted text is all that outlives this call.
            using var document = JsonDocument.Parse(body);

            if (!TryWalk(document.RootElement, field, out var found)) return false;

            text = TextOf(found);
            return true;
        }
        catch (JsonException)
        {
            // A body that opens like a document and then is not one. Malformed JSON on a live
            // topic is ordinary — a truncated publish, a device with a broken serialiser — so it
            // is a skip and not a fault, and the pair's skipped counter says how often it happens.
            return false;
        }
    }

    /// <summary>The number the text is, or null when it is not one.</summary>
    // The mirror of number.ts, including the reasoning it carries: Number() is not the test,
    // because it reads '0x10' as sixteen, an empty body as zero and 'Infinity' as a value no
    // chart can place. A topic sending readings sends them written out.
    public static double? AsReading(string? text)
    {
        // `if (!text) return null` — an empty body is falsy in the browser, and an empty body is
        // not a zero here either. A topic that publishes nothing at all has not published a
        // reading of zero, and a '< 10' rule must not fire on its silence.
        if (string.IsNullOrEmpty(text)) return null;

        var body = text.Trim();
        if (!ReadingPattern.IsMatch(body)) return null;

        // The pattern has already agreed this is digits and at most one exponent, so the only way
        // left to fail is a magnitude a double cannot hold. '1e999' parses in the browser as
        // Infinity — and the browser then has a second gate for it, since series.ts keeps a
        // reading only when Number.isFinite says so. This is that gate, brought inside the parse
        // because here there is no chart layer above to hold it: an infinity reaching a threshold
        // is a rule that fires for ever on a value that never crossed the wire, and it would be
        // written into a window whose mean and standard deviation are then both infinite.
        return double.TryParse(body, NumberStyles.Float, CultureInfo.InvariantCulture, out var value)
               && double.IsFinite(value)
            ? value
            : null;
    }

    /// <summary>Walks a dotted path with array indices, or answers that it is not there.</summary>
    // The browser walks with a plain property lookup and gets array indexing for nothing, because
    // JavaScript answers arr['0']. C# does not, so the two forms are spelled out here and both are
    // accepted: 'radios[0].crc' because that is the shape the spec and the rule editor write, and
    // 'radios.0.crc' because that is the shape numericFields() produces and therefore the shape a
    // reader copies off a chip in the chart's field list. Accepting only one of them would make a
    // path that works in the console fail in a rule.
    //
    // Separators are strict — 'a..b' and a trailing dot are refused rather than read as a lookup
    // of a field named '' — because they are typos, and a typo that silently becomes a path to
    // nothing is a rule that never fires with no reason on screen.
    private static bool TryWalk(JsonElement root, string path, out JsonElement found)
    {
        found = root;

        var text = path.AsSpan().Trim();
        var at = 0;

        // '$' is the document, which is how the spec's example writes it ('$.a.b[0].c') and how
        // the rule editor pre-fills a path. It is stripped and means nothing more; 'a.b' walks
        // the same document. Only stripped when the path goes on with '.' or '[' or ends there,
        // so a field genuinely named '$temp' is still a name.
        if (text.Length > 0 && text[0] == '$' && (text.Length == 1 || text[1] == '.' || text[1] == '['))
            at++;

        var steps = 0;

        while (at < text.Length)
        {
            // After the first step, the only things that may come next are a dot and a bracket.
            // 'a[0]b' is a typo, not a path.
            if (steps > 0 && text[at] != '.' && text[at] != '[') return false;

            if (text[at] == '.')
            {
                at++;
                if (at >= text.Length || text[at] == '.' || text[at] == '[') return false;
            }

            // Counted before the lookup, so the seventh level costs nothing at all: neither a
            // property search nor a bounds check on an array the path had no business reaching.
            if (++steps > MaxDepth) return false;

            if (text[at] == '[')
            {
                var close = text[at..].IndexOf(']');
                if (close < 0) return false;

                if (!TryIndex(text.Slice(at + 1, close - 1), found, out var element)) return false;

                found = element;
                at += close + 1;
                continue;
            }

            var end = text[at..].IndexOfAny('.', '[');
            var name = end < 0 ? text[at..] : text.Slice(at, end);
            at = end < 0 ? text.Length : at + end;

            // A bare segment against an array is an index, which is what makes 'radios.1.crc'
            // work. Against anything else it is a property name.
            if (found.ValueKind == JsonValueKind.Array)
            {
                if (!TryIndex(name, found, out var element)) return false;

                found = element;
                continue;
            }

            // A path that has run onto a scalar — 'temp.deeper' where temp is 23.5 — has not
            // found anything, and neither has one asking an object for a name it does not carry.
            if (found.ValueKind != JsonValueKind.Object) return false;
            if (!found.TryGetProperty(name, out var child)) return false;

            found = child;
        }

        return true;
    }

    /// <summary>The element at an index, when the digits are digits and the array is long enough.</summary>
    // The digits are checked before int.TryParse rather than left to it, so there is one rule
    // about what an index is: ASCII digits and nothing else. No sign — '[-1]' is not an index
    // counted from the end, because the browser has no such notion and inventing one here would
    // put a path in a rule that the chart cannot follow — and no whitespace. An index too large
    // for an int fails the parse and is refused with the same answer as one past the end.
    private static bool TryIndex(ReadOnlySpan<char> digits, JsonElement array, out JsonElement element)
    {
        element = default;

        if (array.ValueKind != JsonValueKind.Array || digits.Length == 0) return false;

        foreach (var character in digits)
            if (character is < '0' or > '9')
                return false;

        if (!int.TryParse(digits, NumberStyles.None, CultureInfo.InvariantCulture, out var index)) return false;
        if (index >= array.GetArrayLength()) return false;

        element = array[index];
        return true;
    }

    /// <summary>What the leaf says, as text.</summary>
    // A string gives its value, unquoted and unescaped, because a pattern rule is written about
    // the words a device wrote and not about the quotation marks JSON put round them. Everything
    // else gives the text exactly as it arrived: a number keeps the digits it was published with,
    // so '12.50' stays '12.50' and asReading reads it; true and false read as themselves; null
    // reads as 'null', which is an answer and not an absence; and an object or an array hands
    // back its own JSON, so a pattern rule can still look inside a subtree the path stopped at.
    private static string TextOf(JsonElement element) =>
        element.ValueKind == JsonValueKind.String ? element.GetString()! : element.GetRawText();
}
