using System.Text.RegularExpressions;
using MqttForge.Application.Alerts;

namespace MqttForge.Application.Flows;

/// <summary>Which branch an If sends a message down, or that it sends it down neither.</summary>
public enum FlowVerdict { Yes, No, Skip }

/// <summary>The question an If asks of the text it read.</summary>
// Skip is the alert engine's "missing data is not false", carried over whole: a field the message
// does not carry, or a number test over text that is not a number, sends the message down neither
// branch. Reading it as "no" would clear an alarm every time a device said 'warming up'.
public abstract class IfTest
{
    /// <param name="text">What the field held, or null when the message did not carry it.</param>
    public abstract FlowVerdict Judge(string? text);

    protected static FlowVerdict Of(bool answer) => answer ? FlowVerdict.Yes : FlowVerdict.No;
}

/// <summary>gt, gte, lt, lte.</summary>
public sealed class CompareTest(string op, double value) : IfTest
{
    public override FlowVerdict Judge(string? text)
    {
        if (PayloadValue.AsReading(text) is not { } reading) return FlowVerdict.Skip;

        return Of(op switch
        {
            "gt" => reading > value,
            "gte" => reading >= value,
            "lt" => reading < value,
            _ => reading <= value,
        });
    }
}

/// <summary>eq and neq: as numbers when both sides are numbers, as text otherwise.</summary>
// Both ways because both are what people mean. "status eq on" is text; "temp eq 90" has to be true
// for a payload of 90.0, which no text comparison would say.
public sealed class EqualsTest(bool negate, string value) : IfTest
{
    private readonly double? _number = PayloadValue.AsReading(value);

    public override FlowVerdict Judge(string? text)
    {
        if (text is null) return FlowVerdict.Skip;

        var equal = _number is { } number && PayloadValue.AsReading(text) is { } reading
            ? reading == number
            : string.Equals(text, value, StringComparison.Ordinal);

        return Of(equal != negate);
    }
}

/// <summary>Inclusive at both ends.</summary>
public sealed class BetweenTest(double low, double high) : IfTest
{
    public override FlowVerdict Judge(string? text) =>
        PayloadValue.AsReading(text) is { } reading ? Of(reading >= low && reading <= high) : FlowVerdict.Skip;
}

/// <summary>A regex, compiled the way every regex in this product is — see CompiledPatterns.</summary>
public sealed class MatchesTest(Regex regex) : IfTest
{
    // RegexMatchTimeoutException is let out on purpose: the runtime counts it on the node, which
    // is where somebody looking at a flow that stopped branching will look.
    public override FlowVerdict Judge(string? text) =>
        text is null ? FlowVerdict.Skip : Of(regex.IsMatch(text));
}

/// <summary>One of a list of texts.</summary>
public sealed class OneOfTest(IReadOnlySet<string> values) : IfTest
{
    public override FlowVerdict Judge(string? text) =>
        text is null ? FlowVerdict.Skip : Of(values.Contains(text));
}

/// <summary>Whether the field is there at all — the one test a missing field answers "no" to.</summary>
public sealed class ExistsTest : IfTest
{
    public override FlowVerdict Judge(string? text) => Of(text is not null);
}
