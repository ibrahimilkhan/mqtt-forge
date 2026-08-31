using MqttForge.Application.Alerts.Conditions;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Alerts;

// One (rule, topic) pair, created on the first arrival that matches and holding everything the
// lifecycle needs to know about that one pairing. Mutable and unguarded on purpose: only the
// pump ever touches it, and the alternative — a lock per pair, twenty thousand of them — buys
// safety the single-threaded design already has.
public sealed class RuleState
{
    public RuleState(string ruleId, string topic, TopicWindow? window)
    {
        RuleId = ruleId;
        Topic = topic;
        Window = window;
    }

    public string RuleId { get; }
    public string Topic { get; }

    // Null unless a condition on this rule reads history. Opening a ring for every pair would
    // spend the budget on readings nothing reads.
    public TopicWindow? Window { get; }

    /// <summary>What this pair's rule needs of its ring, worked out when the pair was opened.</summary>
    // Required rather than nullable: Track is the only place a pair is made, the plan is what
    // sized the ring beside it, and a pair that had one and not the other would be a pair whose
    // ring nobody could explain. Everything the plan reads is inside ConfigHash, so an edit that
    // could change it drops the pair — which is why this is `init` and never moves afterwards.
    public required WindowPlan Plan { get; init; }

    /// When this topic last carried a non-replay message. Carries the message's own arrival
    /// stamp, not the engine's clock: a burst that queued behind a slow pump must not look as
    /// though it all landed at the moment the pump got to it.
    public DateTimeOffset? LastSeen { get; set; }

    /// When the fire condition first became true and has stayed true. Null when it is not true —
    /// which is also how the tick knows an active alarm has something to answer for.
    public DateTimeOffset? TrueSince { get; set; }

    /// When the fire condition was last actually evaluated, skips not counted. A maturing 'for'
    /// reads this so that a stream going quiet cannot ripen a half-finished one by itself.
    public DateTimeOffset? LastEvaluated { get; set; }

    public Alert? Active { get; set; }
    public DateTimeOffset? CooldownUntil { get; set; }
    public DateTimeOffset? MutedUntil { get; set; }

    public long Evaluated { get; set; }
    public long Skipped { get; set; }
    public int PatternTimeouts { get; set; }

    /// <summary>Readings refused a place in the ring, in a row, by an outlier condition.</summary>
    // The count of consecutive refusals and not of refusals, which is the whole point of it: a
    // line that spikes once a minute is a line with spikes on it, and a line that has been refused
    // fifty readings in a row is a line that has moved. Reset by the first reading that is
    // accepted, which is why a single normal reading in the middle of a step starts the count
    // again — a step that keeps being interrupted is not yet somewhere the plant lives.
    public int OutlierRun { get; set; }
}
