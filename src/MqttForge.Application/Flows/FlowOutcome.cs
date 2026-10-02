using MqttForge.Application.Alerts;
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
//
// The alarms are one list, in the order they went up and came down, and the engine tells them in
// that order, to the notifier and the dispatcher alike. Neither kind can go first every time. One
// outcome can hold both ends of one alarm — a For each over [95, 50] raises it on the first element
// and clears it on the second — and a console told of the clear first would drop nothing, then add
// the raise, and show an alarm that was already over. And it can hold an end and then a raise on
// the same rule and topic: a clear and the next hot reading, or a move to a broker that carries the
// same plant. A channel outside the process knows an alarm by those two alone — a publish goes to a
// topic named by them, and a webhook's body carries no id — so told the raise first, it would hear
// the new alarm end with the old one.
public sealed record FlowOutcome(
    IReadOnlyList<FlowPublish> Publishes,
    IReadOnlyList<AlertEvent> Alarms,
    IReadOnlyList<FlowDebugEntry> Debug)
{
    public static FlowOutcome Empty { get; } = new([], [], []);

    public bool IsEmpty => Publishes.Count == 0 && Alarms.Count == 0 && Debug.Count == 0;

    /// <summary>The alarms that went up. One kind read out of <see cref="Alarms"/>, which alone says what came before what.</summary>
    public IReadOnlyList<Alert> Raised => [.. Alarms.Where(alarm => alarm.Raised).Select(alarm => alarm.Alert)];

    /// <summary>The alarms that came down, read out the same way.</summary>
    public IReadOnlyList<Alert> Resolved => [.. Alarms.Where(alarm => !alarm.Raised).Select(alarm => alarm.Alert)];

    /// <summary>The outcomes one after another, in the order they are given.</summary>
    public static FlowOutcome Merge(IEnumerable<FlowOutcome> outcomes)
    {
        var all = outcomes.Where(outcome => !outcome.IsEmpty).ToList();
        if (all.Count == 0) return Empty;
        if (all.Count == 1) return all[0];

        return new FlowOutcome(
            [.. all.SelectMany(outcome => outcome.Publishes)],
            [.. all.SelectMany(outcome => outcome.Alarms)],
            [.. all.SelectMany(outcome => outcome.Debug)]);
    }
}
