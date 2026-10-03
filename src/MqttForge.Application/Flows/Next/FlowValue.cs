using MqttForge.Application.Alerts;

namespace MqttForge.Application.Flows.Next;

/// <summary>Where a setting reads a value from: the whole payload, a field of it, or a variable.</summary>
// One way to write it everywhere a field is asked for — If's field, For each's array, Raise alarm's
// value: empty for the payload, $.path for a field, var.name for a variable. The prefix tells them
// apart, and the editor writes the same three.
public sealed class FlowValue
{
    private readonly string? _field;

    private FlowValue(string text, string? field, string? variable)
    {
        Text = text;
        _field = field;
        Variable = variable;
    }

    public static FlowValue Payload { get; } = new("", null, null);

    /// <summary>As it was written, trimmed.</summary>
    public string Text { get; }

    /// <summary>The variable it reads, or null when it reads the message.</summary>
    public string? Variable { get; }

    public static FlowValue Parse(string text, out string? problem)
    {
        problem = null;
        var trimmed = text.Trim();

        if (trimmed.Length == 0) return Payload;
        if (trimmed.StartsWith('$')) return new FlowValue(trimmed, trimmed, null);

        if (trimmed.StartsWith(FlowVariables.Prefix, StringComparison.Ordinal) &&
            FlowVariables.IsName(trimmed[FlowVariables.Prefix.Length..]))
            return new FlowValue(trimmed, null, trimmed[FlowVariables.Prefix.Length..]);

        problem = "Write $.field for a field of the message, var.name for a variable, or leave it empty for the whole payload.";
        return Payload;
    }

    /// <summary>The text it reads, or null when the message does not carry the field.</summary>
    public string? Read(FlowMessage message, IReadOnlyDictionary<string, string> variables)
    {
        if (Variable is not null) return variables.TryGetValue(Variable, out var value) ? value : null;

        return PayloadValue.TryExtract(message.Payload, _field, out var text) ? text : null;
    }
}
