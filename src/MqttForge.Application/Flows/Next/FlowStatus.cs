namespace MqttForge.Application.Flows.Next;

/// <summary>Every run there is, as the console draws it.</summary>
// A run that finished or stopped stays here until it is replaced, so the page can still show where a
// test ended and what each node did on the way.
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
