using MqttForge.Application.Alerts.Statistics;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Alerts.Conditions;

/// <summary>
/// Answers one condition against one arrival. Holds nothing itself: the same context and the same
/// condition give the same verdict every time, unless the condition is one of the two whose truth
/// is a claim about the pair rather than about the message — and those keep their memory on the
/// pair, in RuleState, which arrives on the context. A pattern that runs out of time throws
/// <c>RegexMatchTimeoutException</c> rather than answering.
/// </summary>
// Kept apart from AlertEngineCore because the lifecycle and the logic fail in different ways and
// should be read separately. What fires is a question about one message; when it fires — For,
// Clear, Cooldown, the tick — is a question about a sequence, and mixing them would mean testing
// 'is 94.2 greater than 90' through a fake clock.
//
// The statistical family bends that line and it is worth saying exactly how far. A distribution
// shift is a question about a window, and the window's own history — what it has settled into, how
// many cycles ago — has to live somewhere the next arrival can find it. Running the machine in the
// core instead was considered and rejected: the core would have to walk each rule's condition tree
// looking for statistical arms before every arrival, which is this class's own job, and two walks
// of one tree are two answers waiting to disagree.
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
        SilenceCondition c => Silence(c, context.Now, context.LastSeen),

        // The ring in the context is the ring as it stood BEFORE this message: AlertEngineCore
        // writes the arriving reading after the evaluation, and only if this arm did not call it
        // an outlier. Judged here and written there, from the same function, so the fence a rule
        // fires on and the fence the next reading is measured against cannot come apart.
        OutlierCondition c => Outlier.Judge(c, context.Window, context.Number),

        // The two edge conditions read the machine rather than running it, so they answer on every
        // arrival — the once-a-second quota is on the looking, not on the answering. That is what
        // keeps the rest of the lifecycle ordinary: a cooldown, a resolve and a repeat count all
        // work on a distribution shift exactly as they do on a threshold.
        DistributionShiftCondition => Shift(in context),
        ShapeChangeCondition => Changed(in context),

        // Pulse has nothing to read back and so has to measure, which is why it alone is Skipped
        // between passes.
        PulseCondition c => Pulse(c, in context),

        // Not a silent default. A condition type this build does not evaluate has to reach the
        // engine's per-pair catch, so the rule is marked Faulted and the panel names it — the
        // alternative is a rule that looks fine and never fires.
        // Every type in AlertCondition's [JsonDerivedType] list has an arm above, so getting
        // here means a condition exists that this switch was never taught. The two possible
        // answers are Skipped and throw, and Skipped is the wrong one: it reads as "this
        // message could not be judged", which is a sentence about the message, and the rule
        // would then sit there for ever, never firing, never saying why, and looking exactly
        // like a rule whose topic is simply quiet. Throwing puts the rule's name and this
        // type's name in front of the user once, through the Faulted diagnostic, and stops
        // the engine paying for it. Nothing a user can type reaches here — the store already
        // drops rules it cannot bind when it loads them — so this is a fault in our own
        // code, and faults in our own code should be loud in one place and silent everywhere
        // else.
        _ => throw new NotSupportedException(
            $"No arm for condition type '{condition.GetType().Name}'."),
    };    private static Verdict Threshold(ThresholdCondition condition, double? number)
    {
        // IsFinite, not just null. Nothing upstream should hand this a NaN — asReading's pattern
        // rejects 'NaN' and 'Infinity', and the C# side is held to the same answers by the shared
        // vectors — but Neq is the one operator that fires on a NaN if one ever gets through,
        // because every comparison against NaN is false and 'not equal' inherits it.
        if (number is not { } value || !double.IsFinite(value)) return Verdict.Skipped;

        return Holds(value, condition.Op, condition.Value) ? Verdict.True : Verdict.False;
    }

    /// <summary>One number against another, the six ways a rule may ask for it.</summary>
    // Lifted out of Threshold when the pulse condition arrived, rather than copied into it. A
    // second operator table is a second set of answers to 'does gte include the edge', and the one
    // thing worse than getting that wrong is getting it wrong in one of two places.
    private static bool Holds(double value, ThresholdOp op, double against) => op switch
    {
        ThresholdOp.Gt => value > against,
        ThresholdOp.Gte => value >= against,
        ThresholdOp.Lt => value < against,
        ThresholdOp.Lte => value <= against,

        // Exact, with no epsilon. There is no principled tolerance for a number a person
        // typed into a box, and a made-up one would make 'eq 0' true for 1e-12; the payloads
        // people compare exactly are mode numbers and fault codes, which are exact.
        ThresholdOp.Eq => value == against,
        ThresholdOp.Neq => value != against,

        _ => throw new NotSupportedException($"No comparison for {op}.")
    };

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

    /// <summary>
    /// The window's readings stopped fitting what this pair had settled into.
    /// </summary>
    // The condition's own Window is deliberately not read here. The pair has one ring, sized by
    // WindowPlan to the largest window anything on the rule's tree asked for — the outlier
    // conditions from task 5, these three once the ring task teaches the walk about them — and it
    // is judged on that ring: a pair cannot hold two histories, and the arm that asked for the
    // longer one asked to be judged on it. For the rule everybody actually writes — one
    // statistical condition — the ring is that condition's window exactly.
    private static Verdict Shift(in EvalContext context)
    {
        if (context.State is not { } state || context.Window is not { } window) return Verdict.Skipped;

        // Warming up. Skipped rather than False, because False is an answer and an answer here
        // would clear an alarm on the strength of a run too short to have an opinion.
        if (Statistical.Warming(window)) return Verdict.Skipped;

        Statistical.Cycle(state, window, context.Now);

        return Statistical.FitChanged(state) ? Verdict.True : Verdict.False;
    }

    /// <summary>The window's readings stopped being the kind of signal they were.</summary>
    // The same machine and the same cycle as the distribution above — whichever of the two arms is
    // evaluated first moves both families on, and the second one reads what the first settled.
    private static Verdict Changed(in EvalContext context)
    {
        if (context.State is not { } state || context.Window is not { } window) return Verdict.Skipped;
        if (Statistical.Warming(window)) return Verdict.Skipped;

        Statistical.Cycle(state, window, context.Now);

        return Statistical.ShapeChanged(state) ? Verdict.True : Verdict.False;
    }

    /// <summary>One number about the rhythm of the whole window, against one value.</summary>
    // The only arm in this class that answers Skipped for a reason that is not about the message:
    // between passes there is nothing to answer from, because a rhythm is measured rather than
    // remembered. That makes a pulse rule on a fifty-a-second topic report forty-nine skips a
    // second, and the panel is right to show it — the rule really does judge that topic once a
    // second, and a silent no-op would make a working rule look like a faulted one.
    private static Verdict Pulse(PulseCondition condition, in EvalContext context)
    {
        if (context.State is not { } state || context.Window is not { } window) return Verdict.Skipped;
        if (Statistical.Warming(window)) return Verdict.Skipped;
        if (!Statistical.MayLook(state, context.Now)) return Verdict.Skipped;

        Statistical.Look(state, context.Now);

        if (Statistical.PulsesFor(window) is not { } pulses) return Verdict.Skipped;

        // A period with one excursion behind it, or a width with none finished. The metric does not
        // exist yet, which is not the same as its being small: a pump that has pulsed once has no
        // period, and a rule reading that as 'the period is nought' would fire on the first event
        // every sensor in the plant ever produces.
        if (Statistical.MetricOf(pulses, condition.Metric) is not { } measured) return Verdict.Skipped;

        return Holds(measured, condition.Op, condition.Value) ? Verdict.True : Verdict.False;
    }
}
