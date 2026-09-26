using MqttForge.Domain.Models;

namespace MqttForge.Application.Flows;

/// <summary>A publish a flow asked for, and which node asked, so a failure can be counted there.</summary>
public sealed record FlowPublish(string FlowId, string NodeId, PublishRequest Request);

/// <summary>A line for the console's debug strip: what a Debug node printed, or what went wrong.</summary>
public sealed record FlowDebugEntry(string FlowId, string NodeId, DateTimeOffset At, string Kind, string Topic, string Text)
{
    public const string Message = "message";
    public const string Error = "error";
}

/// <summary>Everything one call into the runtime decided, for the engine to carry out.</summary>
// The runtime decides and never does. A publish here has not been sent and an alarm here has not
// been announced; the engine does both, off the thread, so a test of the runtime is a list of
// calls and a list of what came back.
public sealed record FlowOutcome(
    IReadOnlyList<FlowPublish> Publishes,
    IReadOnlyList<Alert> Raised,
    IReadOnlyList<Alert> Resolved,
    IReadOnlyList<FlowDebugEntry> Debug)
{
    public static FlowOutcome Empty { get; } = new([], [], [], []);

    public bool IsEmpty => Publishes.Count == 0 && Raised.Count == 0 && Resolved.Count == 0 && Debug.Count == 0;

    public static FlowOutcome Merge(IEnumerable<FlowOutcome> outcomes)
    {
        var all = outcomes.Where(outcome => !outcome.IsEmpty).ToList();
        if (all.Count == 0) return Empty;
        if (all.Count == 1) return all[0];

        return new FlowOutcome(
            [.. all.SelectMany(outcome => outcome.Publishes)],
            [.. all.SelectMany(outcome => outcome.Raised)],
            [.. all.SelectMany(outcome => outcome.Resolved)],
            [.. all.SelectMany(outcome => outcome.Debug)]);
    }
}
