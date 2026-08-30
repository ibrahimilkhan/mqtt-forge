using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Alerts.Conditions;

/// <summary>
/// Answers one condition against one arrival. Holds nothing, decides nothing about alerts: the
/// same context and the same condition give the same verdict every time. A pattern that runs out
/// of time throws <c>RegexMatchTimeoutException</c> rather than answering.
/// </summary>
// Kept apart from AlertEngineCore because the lifecycle and the logic fail in different ways and
// should be read separately. What fires is a question about one message; when it fires — For,
// Clear, Cooldown, the tick — is a question about a sequence, and mixing them would mean testing
// 'is 94.2 greater than 90' through a fake clock.
//
// Skipped is never False. Every arm below returns it rather than a negative when there was
// nothing to judge, and the composites carry it upward: the spec's 'Eksik veri değerlendirilmez,
// yanlış sayılmaz' is enforced here or nowhere.
public sealed class ConditionEvaluator
{
    private readonly CompiledPatterns _patterns;

    public ConditionEvaluator(CompiledPatterns patterns) => _patterns = patterns;

    public Verdict Evaluate(AlertCondition condition, in EvalContext context) => condition switch
    {
        ThresholdCondition c => Threshold(c, context.Number),
        BandCondition c => Band(c, context.Number),
        PatternCondition c => Pattern(c, context.Text),
        OneOfCondition c => OneOf(c, context.Text),
        AllCondition c => All(c, in context),
        AnyCondition c => Any(c, in context),

        // Silence is a fact about time passing and is settled by the tick, which does not exist
        // yet. Skipped rather than a throw, so a rule set carrying one is loadable now and the
        // rule is merely quiet rather than Faulted. Final task 10 replaces this arm with one that
        // measures the gap between context.Now and context.LastSeen.
        SilenceCondition c => Silence(c, context.Now, context.LastSeen),

        // Not a silent default. A condition type this build does not evaluate has to reach the
        // engine's per-pair catch, so the rule is marked Faulted and the panel names it — the
        // alternative is a rule that looks fine and never fires.
        _ => throw new NotSupportedException($"No evaluator for {condition.GetType().Name}.")
    };

    private static Verdict Threshold(ThresholdCondition condition, double? number)
    {
        // IsFinite, not just null. Nothing upstream should hand this a NaN — asReading's pattern
        // rejects 'NaN' and 'Infinity', and the C# side is held to the same answers by the shared
        // vectors — but Neq is the one operator that fires on a NaN if one ever gets through,
        // because every comparison against NaN is false and 'not equal' inherits it.
        if (number is not { } value || !double.IsFinite(value)) return Verdict.Skipped;

        var fired = condition.Op switch
        {
            ThresholdOp.Gt => value > condition.Value,
            ThresholdOp.Gte => value >= condition.Value,
            ThresholdOp.Lt => value < condition.Value,
            ThresholdOp.Lte => value <= condition.Value,

            // Exact, with no epsilon. There is no principled tolerance for a number a person
            // typed into a box, and a made-up one would make 'eq 0' true for 1e-12; the payloads
            // people compare exactly are mode numbers and fault codes, which are exact.
            ThresholdOp.Eq => value == condition.Value,
            ThresholdOp.Neq => value != condition.Value,

            _ => throw new NotSupportedException($"No comparison for {condition.Op}.")
        };

        return fired ? Verdict.True : Verdict.False;
    }

    private static Verdict Band(BandCondition condition, double? number)
    {
        if (number is not { } value || !double.IsFinite(value)) return Verdict.Skipped;

        // Both edges belong to the inside: a 4-20mA line reading exactly 20.0 is at the top of its
        // range and not out of it, and an exclusive edge would fire on the one reading a saturated
        // sensor produces most often.
        //
        // A band written backwards has no inside, so 'inside' is false for every value and
        // 'outside' is true for every value. Not corrected here: swapping the edges would make
        // 4..20 and 20..4 the same rule, and the place to refuse a backwards band is the
        // validator, where the user is still looking at it.
        var within = value >= condition.Low && value <= condition.High;

        return within == condition.Inside ? Verdict.True : Verdict.False;
    }

    private Verdict Pattern(PatternCondition condition, string? text)
    {
        if (text is null) return Verdict.Skipped;

        // The timeout is deliberately NOT caught here. A pattern that ran out of time judged
        // nothing, and this method's only way of saying so would be Verdict.Skipped — which is
        // indistinguishable from an absent field, and the engine has to be able to tell them
        // apart: ten timeouts in a row is a rule spending half a second of a single-threaded
        // engine per message, and the engine is the only thing that can count them. Final task 14
        // catches RegexMatchTimeoutException, counts it against the pair, and turns it into the
        // same Skipped on the way out — which is also why a timeout must never be reported as a
        // non-match, since a negated pattern would then fire on the very message that broke it.
        return _patterns[condition].IsMatch(text) != condition.Negate ? Verdict.True : Verdict.False;
    }

    private static Verdict OneOf(OneOfCondition condition, string? text)
    {
        if (text is null) return Verdict.Skipped;

        // Ordinal and untrimmed. A device sending 'ON' is not sending 'on', and folding the two
        // together would make an allow-list quietly accept a payload nobody wrote down.
        //
        // An empty list permits nothing and, negated, forbids nothing. Degenerate, but it is one
        // delete key away in the editor and both answers have to be the boring one.
        var listed = false;
        for (var i = 0; i < condition.Values.Count && !listed; i++)
            listed = string.Equals(condition.Values[i], text, StringComparison.Ordinal);

        return listed != condition.Negate ? Verdict.True : Verdict.False;
    }

    // Short-circuits on the first False, so a composite whose cheap first clause settles it never
    // runs the pattern behind it. Skipped does not short-circuit: a later child may still be
    // False, and False is what an 'all' is looking for.
    private Verdict All(AllCondition condition, in EvalContext context)
    {
        var skipped = false;

        foreach (var child in condition.Of)
            switch (Evaluate(child, in context))
            {
                case Verdict.False: return Verdict.False;
                case Verdict.Skipped: skipped = true; break;
            }

        // An empty conjunction is true, as it is everywhere else.
        return skipped ? Verdict.Skipped : Verdict.True;
    }

    private Verdict Any(AnyCondition condition, in EvalContext context)
    {
        var skipped = false;

        foreach (var child in condition.Of)
            switch (Evaluate(child, in context))
            {
                case Verdict.True: return Verdict.True;
                case Verdict.Skipped: skipped = true; break;
            }

        // An empty disjunction is false, as it is everywhere else.
        return skipped ? Verdict.Skipped : Verdict.False;
    }

    // The only condition whose truth is about time passing rather than about a message. A pair
    // that has never been heard from and was never armed answers Skipped rather than True: with a
    // wildcard filter the engine has no inventory of the topics that ought to exist, so it can
    // only miss what it has met. An armed pair (a filter with no wildcard) carries the arming
    // moment in LastSeen, which is what makes 'this device has never spoken' checkable at all.
    private static Verdict Silence(SilenceCondition condition, DateTimeOffset now, DateTimeOffset? lastSeen)
    {
        if (lastSeen is not { } seen) return Verdict.Skipped;

        // Inclusive, like every other deadline in this engine: 'quiet for 60s' is satisfied by
        // exactly sixty seconds.
        return now - seen >= TimeSpan.FromSeconds(condition.After) ? Verdict.True : Verdict.False;
    }
}
