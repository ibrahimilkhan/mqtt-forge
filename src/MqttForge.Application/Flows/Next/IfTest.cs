using System.Text.RegularExpressions;
using MqttForge.Application.Alerts;
using MqttForge.Application.Alerts.Conditions;

namespace MqttForge.Application.Flows.Next;

/// <summary>A step that could not do its job, said in a sentence for its node and the debug strip.</summary>
public sealed class FlowStepException(string message) : Exception(message);

/// <summary>The question an If asks: yes or no, never neither.</summary>
// A run is always somewhere, so a decision always decides. A field the message does not carry, or a
// number test over text that is not a number, is "no" — the flowchart's reading, chosen over the
// alert engine's "skip" on 2026-10-03, since a run stopped half-way at a decision would be stuck.
//
// What the field is compared with is rendered for every message, so it can be a variable. When that
// is not what the test needs — a number, a pattern — it is the step that failed, not the message,
// and FlowStepException says so.
public abstract class IfTest
{
    /// <param name="text">What the field held, or null when it is not there.</param>
    /// <param name="value">The value, rendered.</param>
    /// <param name="value2">The second value, rendered: between reads it, and nothing else does.</param>
    public abstract bool Judge(string? text, string value, string value2);

    // A value may be a variable's sixty-four kilobytes, and what a failure quotes of it goes into a
    // sentence on the node and in the debug strip, where forty characters tell which value it was.
    protected static string Quoted(string value) => FlowTemplate.Clip(value, 40);

    protected static double Number(string value, string what) =>
        PayloadValue.AsReading(value) ??
        throw new FlowStepException($"{what} is not a number: '{Quoted(value)}'.");
}

/// <summary>gt, gte, lt, lte.</summary>
public sealed class CompareTest(string op) : IfTest
{
    public override bool Judge(string? text, string value, string value2)
    {
        var limit = Number(value, "The value to compare with");
        if (PayloadValue.AsReading(text) is not { } reading) return false;

        // The compiler builds a CompareTest for these four ops and for no other. Any other is a mistake
        // in the code that built it, so it is thrown and not answered: an op that read as lte would
        // decide every message wrongly, and nothing would say so.
        return op switch
        {
            "gt" => reading > limit,
            "gte" => reading >= limit,
            "lt" => reading < limit,
            "lte" => reading <= limit,
            _ => throw new ArgumentOutOfRangeException(nameof(op), op, "A comparison this test never makes."),
        };
    }
}

/// <summary>eq and neq: as numbers when both sides are numbers, as text otherwise.</summary>
// Both ways because both are what people mean. "status eq on" is text; "temp eq 90" has to be true
// for a payload of 90.0, which no text comparison would say. A missing field is "no" for neq as well:
// "not on" asks about a status that was said, and a message that said nothing has not said "off".
public sealed class EqualsTest(bool negate) : IfTest
{
    public override bool Judge(string? text, string value, string value2)
    {
        if (text is null) return false;

        var equal = PayloadValue.AsReading(value) is { } number && PayloadValue.AsReading(text) is { } reading
            ? reading == number
            : string.Equals(text, value, StringComparison.Ordinal);

        return equal != negate;
    }
}

/// <summary>Inclusive at both ends.</summary>
public sealed class BetweenTest : IfTest
{
    public override bool Judge(string? text, string value, string value2)
    {
        var low = Number(value, "The lower bound");
        var high = Number(value2, "The upper bound");
        if (low > high) throw new FlowStepException("The lower bound is above the upper bound.");

        return PayloadValue.AsReading(text) is { } reading && reading >= low && reading <= high;
    }
}

/// <summary>A regex, compiled the way every regex in this product is — see CompiledPatterns.</summary>
// A pattern typed into the node is compiled once, by the compiler; one that comes from a variable is
// compiled when it changes, and the last one kept. RegexMatchTimeoutException is let out: the runtime
// counts it on the node and ends the run's turn, since the next text like it costs another 50 ms.
public sealed class MatchesTest(Regex? compiled) : IfTest
{
    // The last pattern and the regex compiled from it are one value in one field, so a reader sees the
    // pair as it was written and never the new regex under the old text. Nothing more is needed: the
    // cache serves one node, on the flow pump's one thread.
    private Entry? _last;

    public override bool Judge(string? text, string value, string value2)
    {
        var regex = compiled ?? Compile(value);
        return text is not null && regex.IsMatch(text);
    }

    private Regex Compile(string pattern)
    {
        if (_last is { } last && string.Equals(pattern, last.Pattern, StringComparison.Ordinal)) return last.Regex;

        try
        {
            var regex = CompiledPatterns.Compile(pattern);
            _last = new Entry(pattern, regex);
            return regex;
        }
        catch (ArgumentException ex)
        {
            // The parser's message quotes the pattern whole, and a variable may hold sixty-four kilobytes
            // of one: the sentence keeps what the parser says of where it went wrong, and quotes only the
            // start of the pattern.
            throw new FlowStepException(
                $"The pattern does not compile: {ex.Message.Replace(pattern, Quoted(pattern), StringComparison.Ordinal)}");
        }
    }

    private sealed record Entry(string Pattern, Regex Regex);
}

/// <summary>One of a comma-separated list of texts.</summary>
public sealed class OneOfTest : IfTest
{
    public override bool Judge(string? text, string value, string value2) =>
        text is not null && value.Split(',').Any(one => one.Trim() is { Length: > 0 } item && string.Equals(item, text, StringComparison.Ordinal));
}

/// <summary>Whether the field is there at all.</summary>
public sealed class ExistsTest : IfTest
{
    public override bool Judge(string? text, string value, string value2) => text is not null;
}
