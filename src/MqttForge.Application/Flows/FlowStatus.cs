using MqttForge.Domain.Models;

namespace MqttForge.Application.Flows;

/// <summary>Every run there is, as the console draws it.</summary>
// A run that finished or stopped stays here until it is replaced, so the page can still show where a
// test ended and what each node did on the way — a test that Stop ended among them. A test that has ended
// can also be taken away: by Stop pressed again, by its flow's delete, which takes one away going or not,
// or to make room for another — see FlowRuntime.StartTest and StopTest.
public sealed record FlowStatus(IReadOnlyList<FlowRunStatus> Runs)
{
    public static FlowStatus Empty { get; } = new([]);
}

/// <summary>Where a run is: going, waiting for a time or a message, finished at an End, or stopped.</summary>
public enum FlowRunState { Running, Waiting, Finished, Stopped }

/// <summary>What a waiting run waits for: the time a Wait ends, or a message on an MQTT in's filter.</summary>
public sealed record FlowWaiting(DateTimeOffset? Until, string? Filter);

/// <summary>One run: its state, the node it is at, what it waits for, its variables, and every node's counters.</summary>
public sealed record FlowRunStatus(
    string FlowId,
    FlowRunKind Kind,
    FlowRunState State,
    string? At,
    FlowWaiting? Waiting,
    string? Fault,
    IReadOnlyDictionary<string, string> Variables,
    IReadOnlyList<FlowNodeStatus> Nodes);

/// <summary>
/// One node: how many times a run entered it, what left by each way out, how many things went wrong,
/// the last thing worth a glance, and — for a Raise alarm — what is standing.
/// </summary>
public sealed record FlowNodeStatus(
    string Id,
    long Count,
    IReadOnlyDictionary<string, long> Outs,
    long Errors,
    string? Note,
    IReadOnlyList<FlowStanding> Standing);

/// <summary>A flow alarm that is up, as its Raise alarm node's pane lists it.</summary>
public sealed record FlowStanding(string Topic, DateTimeOffset FiredAt, string Reason, int Count);

/// <summary>The flow engine's alarms, as GET /api/alerts merges them into the alert engine's.</summary>
public sealed record FlowAlarms(IReadOnlyList<Alert> Active, IReadOnlyList<Alert> History)
{
    public static FlowAlarms Empty { get; } = new([], []);
}
