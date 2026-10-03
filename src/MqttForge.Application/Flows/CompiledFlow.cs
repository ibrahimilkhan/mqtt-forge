using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Flows;

/// <summary>Where a way out leads: a node, and which of its ways in.</summary>
public sealed record FlowTarget(CompiledNode Node, string Port);

/// <summary>A node with its settings read and checked, and its ways out attached.</summary>
// Classes rather than records: the wires are attached after every node exists, because a wire can
// point forwards — and back, for a loop — and a record's value equality over such a graph would walk it.
public abstract class CompiledNode(string id)
{
    private readonly Dictionary<string, FlowTarget> _outs = new(StringComparer.Ordinal);

    public string Id { get; } = id;

    /// <summary>Where a way out leads. In a compiled flow every way out is wired, once.</summary>
    public FlowTarget To(string port) => _outs[port];

    internal void Attach(string port, FlowTarget target) => _outs[port] = target;
}

public sealed class StartNode(string id) : CompiledNode(id);

public sealed class EndNode(string id) : CompiledNode(id);

public sealed class MqttInNode(string id, string filter, bool replay) : CompiledNode(id)
{
    public string Filter { get; } = filter;

    /// <summary>Whether a retained value the broker replays on subscribe is a message this node reads.</summary>
    public bool Replay { get; } = replay;
}

public sealed class IfNode(string id, FlowValue field, IfTest test, FlowTemplate value, FlowTemplate value2) : CompiledNode(id)
{
    public FlowValue Field { get; } = field;
    public IfTest Test { get; } = test;
    public FlowTemplate Value { get; } = value;
    public FlowTemplate Value2 { get; } = value2;
}

public sealed class ForNode(string id, FlowTemplate times, bool forever) : CompiledNode(id)
{
    /// <summary>How many turns, as a template: a number, or a variable that holds one.</summary>
    public FlowTemplate Times { get; } = times;

    public bool Forever { get; } = forever;
}

public sealed class ForEachNode(string id, FlowValue array) : CompiledNode(id)
{
    public FlowValue Array { get; } = array;
}

public sealed class WaitNode(string id, FlowTemplate seconds) : CompiledNode(id)
{
    public FlowTemplate Seconds { get; } = seconds;
}

public sealed class SetNode(string id, string variable, FlowTemplate value) : CompiledNode(id)
{
    public string Variable { get; } = variable;
    public FlowTemplate Value { get; } = value;
}

public sealed class PublishNode(string id, FlowTemplate topic, FlowTemplate payload, int qos, bool retain) : CompiledNode(id)
{
    public FlowTemplate Topic { get; } = topic;
    public FlowTemplate Payload { get; } = payload;
    public int Qos { get; } = qos;
    public bool Retain { get; } = retain;
}

public sealed class DebugNode(string id) : CompiledNode(id);

public sealed class AlarmRaiseNode(string id, string name, AlertSeverity level, FlowTemplate reason, FlowValue value) : CompiledNode(id)
{
    public string Name { get; } = name;
    public AlertSeverity Level { get; } = level;
    public FlowTemplate Reason { get; } = reason;

    /// <summary>What is read as the alarm's number.</summary>
    public FlowValue Value { get; } = value;
}

public sealed class AlarmClearNode(string id, string alarm) : CompiledNode(id)
{
    /// <summary>The id of the Raise alarm node whose alarm this closes.</summary>
    public string Alarm { get; } = alarm;
}

public sealed class SoundNode(string id, AlertSeverity level) : CompiledNode(id)
{
    public AlertSeverity Level { get; } = level;
}

public sealed class NotifyNode(string id, FlowTemplate text, AlertSeverity level) : CompiledNode(id)
{
    public FlowTemplate Text { get; } = text;
    public AlertSeverity Level { get; } = level;
}

public sealed class WebhookNode(string id, string url, FlowTemplate body) : CompiledNode(id)
{
    public string Url { get; } = url;
    public FlowTemplate Body { get; } = body;
}

/// <summary>A flow that compiled: its nodes by id, where it starts, what it reads, and its variables.</summary>
public sealed class CompiledFlow
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required bool Enabled { get; init; }

    /// <summary>What the flow does, with where its nodes stand left out.</summary>
    // What an Update compares. Equal means the active run is kept as it is — where it is, its
    // variables, its alarms — which is what somebody who only moved a node expects.
    public required string Fingerprint { get; init; }

    public required IReadOnlyDictionary<string, CompiledNode> Nodes { get; init; }
    public required StartNode Start { get; init; }
    public required IReadOnlyList<MqttInNode> Inputs { get; init; }
    public required IReadOnlyList<FlowVariable> Variables { get; init; }
}

/// <summary>What compiling one flow came to.</summary>
public sealed record FlowCompileResult(CompiledFlow? Flow, IReadOnlyList<FlowProblem> Problems);

/// <summary>Every flow in a file, compiled: what can run, every id, and what could not compile.</summary>
public sealed record FlowSet(
    IReadOnlyList<CompiledFlow> Compiled,
    IReadOnlyList<string> Kept,
    IReadOnlyList<FlowSetProblem> Problems);
