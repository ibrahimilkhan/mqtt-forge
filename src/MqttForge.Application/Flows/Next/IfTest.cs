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

    protected static double Number(string value, string what) =>
        PayloadValue.AsReading(value) ??
        throw new FlowStepException($"{what} is not a number: '{FlowTemplate.Clip(value, 40)}'.");
}

/// <summary>gt, gte, lt, lte.</summary>
public sealed class CompareTest(string op) : IfTest
{
    public override bool Judge(string? text, string value, string value2)
    {
        var limit = Number(value, "The value to compare with");
        if (PayloadValue.AsReading(text) is not { } reading) return false;

        return op switch
        {
            "gt" => reading > limit,
            "gte" => reading >= limit,
            "lt" => reading < limit,
            _ => reading <= limit,
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
    private string? _lastPattern;
    private Regex? _last;

    public override bool Judge(string? text, string value, string value2)
    {
        var regex = compiled ?? Compile(value);
        return text is not null && regex.IsMatch(text);
    }

    private Regex Compile(string pattern)
    {
        if (_last is not null && string.Equals(pattern, _lastPattern, StringComparison.Ordinal)) return _last;

        try
        {
            _last = CompiledPatterns.Compile(pattern);
            _lastPattern = pattern;
            return _last;
        }
        catch (ArgumentException ex)
        {
            throw new FlowStepException($"The pattern does not compile: {ex.Message}");
        }
    }
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
