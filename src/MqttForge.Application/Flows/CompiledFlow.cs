using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Flows;

/// <summary>Where one output port leads: a node, and which of its inputs.</summary>
public sealed record FlowTarget(CompiledNode Node, string Port);

/// <summary>A node with its settings read and checked, and its wires attached.</summary>
// Classes rather than records: the wires are attached after every node exists, because a wire can
// point forwards, and a record's value equality over a graph with shared nodes would walk it.
public abstract class CompiledNode(string id)
{
    private readonly Dictionary<string, List<FlowTarget>> _outs = new(StringComparer.Ordinal);

    public string Id { get; } = id;

    /// <summary>Where an output port leads, in the order its wires were drawn.</summary>
    public IReadOnlyList<FlowTarget> To(string port) =>
        _outs.TryGetValue(port, out var targets) ? targets : [];

    internal void Attach(string port, FlowTarget target)
    {
        if (!_outs.TryGetValue(port, out var targets)) _outs[port] = targets = [];
        targets.Add(target);
    }
}

public sealed class MqttInNode(string id, string filter, bool replay) : CompiledNode(id)
{
    public string Filter { get; } = filter;

    /// <summary>Whether a retained value replayed on subscribe runs the flow.</summary>
    public bool Replay { get; } = replay;
}

public sealed class EveryNode(string id, TimeSpan interval, string topic, string payload) : CompiledNode(id)
{
    public TimeSpan Interval { get; } = interval;
    public string Topic { get; } = topic;
    public string Payload { get; } = payload;
}

public sealed class InjectNode(string id, string topic, string payload) : CompiledNode(id)
{
    public string Topic { get; } = topic;
    public string Payload { get; } = payload;
}

public sealed class IfNode(string id, string field, IfTest test) : CompiledNode(id)
{
    public string Field { get; } = field;
    public IfTest Test { get; } = test;
}

public sealed class ForEachNode(string id, string field) : CompiledNode(id)
{
    public string Field { get; } = field;
}

public sealed class RepeatNode(string id, int count, TimeSpan interval) : CompiledNode(id)
{
    public int Count { get; } = count;
    public TimeSpan Interval { get; } = interval;
}

public sealed class AlarmNode(
    string id, string name, AlertSeverity severity, FlowTemplate reason, string valueField,
    IReadOnlyList<AlertAction> actions) : CompiledNode(id)
{
    public string Name { get; } = name;
    public AlertSeverity Severity { get; } = severity;
    public FlowTemplate Reason { get; } = reason;

    /// <summary>The field read as the alarm's number; empty reads the whole payload.</summary>
    public string ValueField { get; } = valueField;

    public IReadOnlyList<AlertAction> Actions { get; } = actions;
}

public sealed class PublishNode(string id, FlowTemplate topic, FlowTemplate payload, int qos, bool retain)
    : CompiledNode(id)
{
    public FlowTemplate Topic { get; } = topic;
    public FlowTemplate Payload { get; } = payload;
    public int Qos { get; } = qos;
    public bool Retain { get; } = retain;
}

public sealed class DebugNode(string id) : CompiledNode(id);

/// <summary>A flow that compiled: its nodes by id, and the two kinds that start things.</summary>
public sealed class CompiledFlow
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required bool Enabled { get; init; }

    /// <summary>What the flow does, with where its nodes stand left out.</summary>
    // What a redeploy compares. Equal means the running flow is kept as it is — its counters,
    // its timers, its standing alarms — which is what somebody who only moved a node expects.
    public required string Fingerprint { get; init; }

    public required IReadOnlyDictionary<string, CompiledNode> Nodes { get; init; }
    public required IReadOnlyList<MqttInNode> Inputs { get; init; }
    public required IReadOnlyList<EveryNode> Timers { get; init; }
}
