using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using MqttForge.Application.Alerts;

namespace MqttForge.Application.Flows;

/// <summary>A Publish or Alarm text with <c>{{placeholders}}</c> in it, parsed once at deploy.</summary>
// Parsed at deploy and not at every message, for the same reason CompiledPatterns compiles a
// rule's regex once: this runs once per publish, fifty times a second at the limit, and a template
// that fails has to fail while the person who wrote it is still looking at the editor.
//
// Deliberately small. Seven placeholders cover what the examples and the 2026-09-13 cases need —
// the topic and a level of it, the payload and a field of it, the index, the time and a random
// number for a simulator — and anything cleverer is the Function node's job when it comes.
// Nothing is escaped: a payload template that produces broken JSON publishes broken JSON, which is
// what the person wrote.
public sealed partial class FlowTemplate
{
    private readonly IReadOnlyList<Part> _parts;

    private FlowTemplate(IReadOnlyList<Part> parts) => _parts = parts;

    /// <summary>The text with every placeholder taken out — what a topic check looks at.</summary>
    public string LiteralText =>
        string.Concat(_parts.Where(part => part.Kind == PartKind.Text).Select(part => part.Text));

    /// <summary>
    /// Reads the template. A problem is said in <paramref name="problem"/>, and the template that
    /// comes back then renders the text as it was written, so a caller that only wanted the
    /// problem never has a null to guard.
    /// </summary>
    public static FlowTemplate Parse(string text, out string? problem)
    {
        problem = null;
        var parts = new List<Part>();
        var at = 0;

        while (at < text.Length)
        {
            var open = text.IndexOf("{{", at, StringComparison.Ordinal);
            if (open < 0)
            {
                parts.Add(Part.Literal(text[at..]));
                break;
            }

            if (open > at) parts.Add(Part.Literal(text[at..open]));

            var close = text.IndexOf("}}", open + 2, StringComparison.Ordinal);
            if (close < 0)
            {
                problem = "A {{ is never closed with }}.";
                return Verbatim(text);
            }

            var inner = text[(open + 2)..close].Trim();
            if (!TryRead(inner, out var part, out problem))
                return Verbatim(text);

            parts.Add(part);
            at = close + 2;
        }

        return new FlowTemplate(parts);
    }

    public string Render(FlowMessage message, DateTimeOffset now, Random random)
    {
        // The common case is a payload with no placeholder at all: {"fan":"on"}.
        if (_parts.Count == 1 && _parts[0].Kind == PartKind.Text) return _parts[0].Text;

        var into = new StringBuilder();

        foreach (var part in _parts)
        {
            switch (part.Kind)
            {
                case PartKind.Text:
                    into.Append(part.Text);
                    break;
                case PartKind.Topic:
                    into.Append(message.Topic);
                    break;
                case PartKind.TopicLevel:
                    var levels = message.Topic.Split('/');
                    if (part.Level < levels.Length) into.Append(levels[part.Level]);
                    break;
                case PartKind.Payload:
                    into.Append(message.Payload);
                    break;
                case PartKind.Field:
                    // Missing is empty rather than an error: a template is text, and a reason
                    // reading "k1 at  °C" says more than an alarm that did not fire.
                    if (PayloadValue.TryExtract(message.Payload, part.Text, out var found)) into.Append(found);
                    break;
                case PartKind.Index:
                    into.Append(message.Index.ToString(CultureInfo.InvariantCulture));
                    break;
                case PartKind.Now:
                    into.Append(now.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture));
                    break;
                case PartKind.Random:
                    var value = part.Low + random.NextDouble() * (part.High - part.Low);
                    into.Append(Math.Round(value, 1).ToString("0.0", CultureInfo.InvariantCulture));
                    break;
            }
        }

        return into.ToString();
    }

    private static bool TryRead(string inner, out Part part, out string? problem)
    {
        problem = null;
        part = Part.Literal("");

        switch (inner)
        {
            case "topic":
                part = new Part(PartKind.Topic);
                return true;
            case "payload":
                part = new Part(PartKind.Payload);
                return true;
            case "index":
                part = new Part(PartKind.Index);
                return true;
            case "now":
                part = new Part(PartKind.Now);
                return true;
        }

        if (inner.StartsWith('$'))
        {
            part = new Part(PartKind.Field, Text: inner);
            return true;
        }

        if (TopicLevelPattern().Match(inner) is { Success: true } level)
        {
            part = new Part(PartKind.TopicLevel, Level: int.Parse(level.Groups[1].Value, CultureInfo.InvariantCulture));
            return true;
        }

        if (RandomPattern().Match(inner) is { Success: true } random)
        {
            var low = double.Parse(random.Groups[1].Value, CultureInfo.InvariantCulture);
            var high = double.Parse(random.Groups[2].Value, CultureInfo.InvariantCulture);

            if (low > high)
            {
                problem = $"{{{{{inner}}}}} has its bounds the wrong way round: the lower one goes first.";
                return false;
            }

            part = new Part(PartKind.Random, Low: low, High: high);
            return true;
        }

        problem = $"{{{{{inner}}}}} is not something a template can fill in. Use topic, topic[1], " +
                  "payload, $.field, index, now or random(a,b).";
        return false;
    }

    private static FlowTemplate Verbatim(string text) => new([Part.Literal(text)]);

    [GeneratedRegex(@"^topic\[(\d{1,2})\]$", RegexOptions.CultureInvariant)]
    private static partial Regex TopicLevelPattern();

    [GeneratedRegex(@"^random\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)$", RegexOptions.CultureInvariant)]
    private static partial Regex RandomPattern();

    private enum PartKind { Text, Topic, TopicLevel, Payload, Field, Index, Now, Random }

    private sealed record Part(PartKind Kind, string Text = "", int Level = 0, double Low = 0, double High = 0)
    {
        public static Part Literal(string text) => new(PartKind.Text, Text: text);
    }
}
