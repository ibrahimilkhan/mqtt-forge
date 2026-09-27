using MqttForge.Domain.Models;

namespace MqttForge.Application.Alerts;

/// <summary>An alert that went up, or one that came down.</summary>
// What a turn tells is a list of these rather than an EngineOutcome, because across the calls a turn
// makes the two halves of an outcome can no longer be kept apart: an edit that ends an alarm and the
// next reading that raises its pair again are two calls, and every channel outside the process knows
// an alert by its rule and its topic alone. Told every raise of the turn and then every end, the
// broker's channel published the new alarm and then cleared it, and a webhook heard it end.
public sealed record AlertEvent(Alert Alert, bool Raised)
{
    /// <summary>What one call into the core decided: its raises, then its ends.</summary>
    // What that keeps is each pair's own order, within one call. A pair is looked at once in a call,
    // and there it can be raised and then ended — an arrival rings it, and the same arrival turns out
    // to be a new level — but never ended and raised again: a tick that ends an alarm is done with its
    // pair, and a save or a restore only ends. Across pairs the order is not kept: a tick that ends
    // one topic's alarm and raises another's tells the raise first.
    //
    // That is enough because every channel knows an alert by its pair. The webhook's body names the
    // rule and the topic, the broker's default topic names both, and a rule whose filter can match
    // more than one topic may keep a retained record only at a topic that carries {topic} — the rule
    // validator refuses one that does not — so two pairs of one rule never share a record. Two rules
    // pointed at one fixed topic share it whatever order they are told in. See EngineOutcome.
    public static IEnumerable<AlertEvent> Of(EngineOutcome outcome)
    {
        foreach (var alert in outcome.Raised) yield return new AlertEvent(alert, Raised: true);
        foreach (var alert in outcome.Resolved) yield return new AlertEvent(alert, Raised: false);
    }

    /// <summary>The events in their order, cut wherever a raise follows an end or an end a raise.</summary>
    // One call a run and not one an alert: a turn that only raises is still one call to each
    // channel, as it always was, and only a change of kind costs another.
    public static IEnumerable<(bool Raised, IReadOnlyList<Alert> Alerts)> Runs(IReadOnlyList<AlertEvent> events)
    {
        var run = new List<Alert>();
        var raised = false;

        foreach (var one in events)
        {
            if (run.Count > 0 && one.Raised != raised)
            {
                yield return (raised, run);
                run = [];
            }

            raised = one.Raised;
            run.Add(one.Alert);
        }

        if (run.Count > 0) yield return (raised, run);
    }
}
