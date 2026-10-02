using MqttForge.Domain.Models;

namespace MqttForge.Application.Flows;

/// <summary>What every running flow has done, as the console draws it under each node.</summary>
// Only running flows are in it. A flow that is off, or that did not compile, is simply absent, and
// the console reads that absence as "not running" — one fact said one way.
public sealed record FlowStatus(IReadOnlyList<FlowRunStatus> Flows)
{
    public static FlowStatus Empty { get; } = new([]);
}

/// <summary>One running flow: how often an event of it had to be stopped, and why the last one was.</summary>
public sealed record FlowRunStatus(string Id, string? Fault, IReadOnlyList<FlowNodeStatus> Nodes);

/// <summary>
/// One node: how many messages it took (or, for a trigger, sent), what left by each port, how many
/// things went wrong, the last thing worth a glance, and — for an Alarm — what is standing.
/// </summary>
public sealed record FlowNodeStatus(
    string Id,
    long Count,
    IReadOnlyDictionary<string, long> Outs,
    long Errors,
    string? Note,
    IReadOnlyList<FlowStanding> Standing);

/// <summary>A flow alarm that is up, as its Alarm node's inspector lists it.</summary>
public sealed record FlowStanding(string Topic, DateTimeOffset FiredAt, string Reason, int Count);

/// <summary>The flow engine's alarms, as GET /api/alerts merges them into the alert engine's.</summary>
public sealed record FlowAlarms(IReadOnlyList<Alert> Active, IReadOnlyList<Alert> History)
{
    public static FlowAlarms Empty { get; } = new([], []);
}
