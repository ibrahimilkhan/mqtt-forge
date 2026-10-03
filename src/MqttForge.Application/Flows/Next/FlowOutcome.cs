using MqttForge.Application.Alerts;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Flows.Next;

/// <summary>A publish a run asked for, and which node asked, so a failure can be counted there.</summary>
public sealed record FlowPublish(FlowRunKey Run, string NodeId, PublishRequest Request);

/// <summary>A line for the console's debug strip: what a Debug node printed, or what went wrong.</summary>
public sealed record FlowDebugEntry(string FlowId, string NodeId, DateTimeOffset At, string Kind, string Topic, string Text, bool Test)
{
    public const string Message = "message";
    public const string Error = "error";
}

/// <summary>A Sound node's tone, for every console that is open.</summary>
public sealed record FlowSound(string FlowId, string NodeId, AlertSeverity Level, bool Test);

/// <summary>A Notify node's notice, for every console that is open.</summary>
public sealed record FlowNotice(
    string FlowId, string FlowName, string NodeId, string Text, AlertSeverity Level, DateTimeOffset At, bool Test);

/// <summary>A Webhook node's post: where, what, and as which kind of content.</summary>
public sealed record FlowWebhookPost(FlowRunKey Run, string NodeId, string Url, string Body, string ContentType);

/// <summary>Everything one call into the runtime decided, for the engine to carry out.</summary>
// The runtime decides and never does. A publish here has not been sent, an alarm has not been told, a
// tone has not been played: the engine does all of them, off the thread, so a test of the runtime is
// a list of calls and a list of what came back.
//
// The alarms are one list, in the order they went up and came down, and the engine tells them in
// that order — see AlertEvent.Runs for why neither kind may go first.
public sealed record FlowOutcome(
    IReadOnlyList<FlowPublish> Publishes,
    IReadOnlyList<AlertEvent> Alarms,
    IReadOnlyList<FlowDebugEntry> Debug,
    IReadOnlyList<FlowSound> Sounds,
    IReadOnlyList<FlowNotice> Notices,
    IReadOnlyList<FlowWebhookPost> Webhooks)
{
    public static FlowOutcome Empty { get; } = new([], [], [], [], [], []);

    public bool IsEmpty =>
        Publishes.Count == 0 && Alarms.Count == 0 && Debug.Count == 0 &&
        Sounds.Count == 0 && Notices.Count == 0 && Webhooks.Count == 0;

    /// <summary>The outcomes one after another, in the order they are given.</summary>
    public static FlowOutcome Merge(IEnumerable<FlowOutcome> outcomes)
    {
        var all = outcomes.Where(outcome => !outcome.IsEmpty).ToList();
        if (all.Count == 0) return Empty;
        if (all.Count == 1) return all[0];

        return new FlowOutcome(
            [.. all.SelectMany(outcome => outcome.Publishes)],
            [.. all.SelectMany(outcome => outcome.Alarms)],
            [.. all.SelectMany(outcome => outcome.Debug)],
            [.. all.SelectMany(outcome => outcome.Sounds)],
            [.. all.SelectMany(outcome => outcome.Notices)],
            [.. all.SelectMany(outcome => outcome.Webhooks)]);
    }
}
