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
}
