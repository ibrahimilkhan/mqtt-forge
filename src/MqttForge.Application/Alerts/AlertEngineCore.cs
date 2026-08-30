using System.Globalization;
using MqttForge.Application.Alerts.Conditions;
using MqttForge.Domain;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Alerts;

// Pure and synchronous, and with no clock of its own: 'now' is an argument. A core with an
// injected clock would already be testable; a core with no clock is also reproducible — the same
// sequence of messages and instants always produces the same output, and a test writes a number
// instead of advancing something. Carrying time is the transport's job.
//
// Single-threaded by construction, so there is not a lock in here. The pump is the only caller.
public sealed class AlertEngineCore
{
    private readonly AlertEngineOptions _options;

    // The same rule set in two shapes, because two different questions are asked of it and one
    // shape answers each badly. The list is the file's own order, which is what the panel's
    // diagnostics have to line up with — the row order in the editor and the row order in the
    // rule table are the same order or the user is reading two different lists. The dictionary
    // is that set indexed by id, which is what the tick asks per pair; answering it from the list
    // would be a walk of the whole file per pair per second.
    private IReadOnlyList<AlertRule> _rules = [];
    private readonly Dictionary<string, AlertRule> _byId = new(StringComparer.Ordinal);

    // The pair is the unit of everything: a topic sending fifty messages a second over the
    // threshold has one alarm, and a rule matching a hundred topics has a hundred.
    private readonly Dictionary<(string RuleId, string Topic), RuleState> _pairs = [];

    // History is what closed. An open alarm is in Active, and putting it in both lists would
    // make the panel work out which of the two rows is the live one.
    //
    // A List rather than a LinkedList, newest first. Insert(0, …) shifts at most HistoryDepth
    // references, and that happens when an alarm clears rather than when a message arrives; a
    // LinkedList would save that shift and charge a node allocation per entry plus an indirection
    // on every read, and the panel reads this list whole.
    private readonly List<Alert> _history = [];

    private ConditionEvaluator _evaluator = new(CompiledPatterns.For([]));

    // A sequence for alert ids. Guid was the reflex and it costs the core its purity — a test
    // cannot pin an id it cannot predict. The firing instant plus a counter is unique for the
    // same reason a Guid would be here, and it does not repeat across a restart.
    private long _sequence;

    private static readonly IReadOnlyList<Alert> None = [];

    public AlertEngineCore(AlertEngineOptions options) => _options = options;

    // Creates no pairs. A filter is not an inventory — until a message arrives there is no topic
    // to pair it with, and a '#' rule would otherwise have to invent a broker's whole tree.
    public EngineOutcome SetRules(IReadOnlyList<AlertRule> rules, DateTimeOffset now)
    {
        _rules = rules;
        _byId.Clear();
        foreach (var rule in rules) _byId[rule.Id] = rule;

        // Compiled once with the rule set, never per message: a pattern is user input on the
        // message path, and building a Regex fifty times a second to answer the same question is
        // the cheapest thing in here to get wrong.
        _evaluator = new ConditionEvaluator(CompiledPatterns.For(rules));

        return EngineOutcome.Empty;
    }

    public EngineOutcome OnMessage(MqttMessage message, DateTimeOffset now)
    {
        if (message.Topic.StartsWith(_options.TopicPrefix, StringComparison.Ordinal))
            return EngineOutcome.Empty;

        if (message.Replay) return EngineOutcome.Empty;

        // Allocated only once a rule actually matches, so the common case — a topic nobody wrote
        // a rule for — still costs nothing and still returns the shared Empty.
        List<Alert>? raised = null;

        foreach (var rule in _rules)
        {
            if (!rule.Enabled) continue;
            if (!TopicFilterMatch.Matches(rule.Filter, message.Topic)) continue;

            var key = (rule.Id, message.Topic);
            if (!_pairs.TryGetValue(key, out var state))
            {
                state = new RuleState(rule.Id, message.Topic, WindowFor(rule));
                _pairs[key] = state;
            }

            // The message's own stamp, not the engine's: a queued burst must not collapse onto
            // the moment the pump emptied it.
            state.LastSeen = message.ReceivedAt;

            var found = PayloadValue.TryExtract(message.Payload, rule.Field, out var text);
            var number = found ? PayloadValue.AsReading(text) : null;

            // Filled by arrival rather than by whichever condition wants it, so a condition never
            // has to ask for history that was not kept.
            if (state.Window is not null && number is { } reading)
                state.Window.Add(new Reading(message.ReceivedAt.UtcTicks, reading));

            var context = new EvalContext(
                message.Topic, found ? text : null, number, now, state.LastSeen, state.Window);

            OnArrival(rule, state, message, context, now, raised ??= []);
        }

        return raised is null || raised.Count == 0 ? EngineOutcome.Empty : new EngineOutcome(raised, []);
    }

    // Every resolution in the engine happens here. 'connected' is not read on this path: a
    // resolution is a decision arrival already made, and it should land whether or not the link
    // came back. It is the silence clock and the maturing 'for' that stop while the link is
    // down, because a broker that dropped is one event and not a hundred sensors going quiet.
    public EngineOutcome OnTick(DateTimeOffset now, bool connected)
    {
        List<Alert>? raised = null;
        List<Alert>? resolved = null;

        foreach (var state in _pairs.Values)
        {
            // A rule that is gone or switched off is dealt with when the rule set changes, not
            // here; this only skips it so a stale pair cannot be judged against a rule the
            // engine no longer has.
            if (!_byId.TryGetValue(state.RuleId, out var rule) || !rule.Enabled) continue;

            // Both halves of the tick's story live in there now: a 'for' running out with no
            // message to notice it, and a way out that has been standing long enough to take.
            OnPairTick(rule, state, now, raised ??= [], resolved ??= []);
        }

        return Outcome(raised, resolved);
    }

    public void ClearHistory() => _history.Clear();

    // Not on the message path. The pump takes one after a turn that changed something, which is
    // at most a few times a second, so walking every pair here is cheap where walking them per
    // message would not be.
    public AlertSnapshot Snapshot()
    {
        var active = new List<Alert>();
        var muted = new List<MutedPair>();
        var counts = new Dictionary<string, (int Topics, long Evaluated, long Skipped)>(StringComparer.Ordinal);

        foreach (var state in _pairs.Values)
        {
            if (state.Active is { } alarm) active.Add(alarm);
            if (state.MutedUntil is { } until) muted.Add(new MutedPair(state.RuleId, state.Topic, until));

            counts.TryGetValue(state.RuleId, out var tally);
            counts[state.RuleId] = (tally.Topics + 1, tally.Evaluated + state.Evaluated, tally.Skipped + state.Skipped);
        }

        // Walked over _rules, the file-order list, so a rule that is switched off still gets a
        // row: off has to look different from absent when someone is asking why nothing has gone
        // off all week. A rule that has been removed is a different thing, and it really is gone.
        var diagnostics = new List<RuleDiagnostic>(_rules.Count);
        foreach (var rule in _rules)
        {
            counts.TryGetValue(rule.Id, out var tally);
            diagnostics.Add(new RuleDiagnostic(
                rule.Id,
                tally.Topics,
                tally.Evaluated,
                tally.Skipped,
                // "When did this rule last fire" has one owner, and it is task 13's per-rule
                // tally. Keeping a second copy here — a dictionary written on every raise — is
                // exactly the sort of duplicate that survives a refactor by going stale rather
                // than by breaking, so it is null until the task that owns the counters fills it.
                LastFiredAt: null,
                // Faulted says a rule threw and was taken out of service for this session.
                // Nothing on this path can throw: the patterns were built when the rule set was
                // loaded, and every condition here reads one message and answers. Task 14 gives
                // it a writer.
                Faulted: false,
                FaultReason: null));
        }

        // Dropped and Suppressed have no writer yet: nothing in front of this core is counting
        // drops, and no ceiling has been installed for an alert to be refused by. Both arrive
        // with the ceilings task, which owns the numbers as well as the refusals.
        return new AlertSnapshot(active, [.. _history], muted, diagnostics, 0, 0, []);
    }

    private Alert Close(RuleState state, string because, DateTimeOffset now)
    {
        var closed = state.Active! with { ResolvedAt = now, ResolvedBy = because };
        state.Active = null;
        state.TrueSince = null;

        // Newest first, and trimmed in one call rather than one at a time: a save that drops a
        // hundred ringing pairs at once would otherwise shift the tail a hundred times.
        _history.Insert(0, closed);
        if (_history.Count > _options.HistoryDepth)
            _history.RemoveRange(_options.HistoryDepth, _history.Count - _options.HistoryDepth);

        return closed;
    }

    // Whether this rule's readings have to be kept. Every condition in the core family looks at
    // one message and answers, so none of them do — and opening a ring per pair regardless would
    // spend the whole budget holding readings nothing reads. Written as a walk rather than a
    // 'false' so the conditions that do want history have exactly one place to say so.
    //
    // Task 13 deletes both of these: its Track is the single door a pair comes into being
    // through, it allocates the ring unconditionally because MaxReadings is what it charges
    // against, and two answers to "does this pair get a ring" is one too many.
    private TopicWindow? WindowFor(AlertRule rule) =>
        NeedsWindow(rule.Condition) ? new TopicWindow(_options.DefaultWindow) : null;

    private static bool NeedsWindow(AlertCondition condition) => condition switch
    {
        AllCondition all => all.Of.Any(NeedsWindow),
        AnyCondition any => any.Of.Any(NeedsWindow),
        _ => false
    };

    private string NextId(DateTimeOffset now) =>
        string.Create(CultureInfo.InvariantCulture, $"{now.UtcTicks:x}-{++_sequence:x}");

    // Most messages change nothing, and an outcome saying so should not cost two allocations
    // fifty times a second.
    private static EngineOutcome Outcome(List<Alert>? raised, List<Alert>? resolved) =>
        raised is null && resolved is null
            ? EngineOutcome.Empty
            : new EngineOutcome(raised ?? None, resolved ?? None);

    /// <summary>
    /// Whether a pair whose condition is standing true has stood it long enough to ring.
    /// </summary>
    private bool Matured(AlertRule rule, RuleState state, DateTimeOffset now)
    {
        if (state.TrueSince is not { } since) return false;

        // No For: the arrival that made it true is the alert.
        if (rule.For is not { } seconds) return true;

        // The boundary is inclusive. 'For thirty seconds' is satisfied by exactly thirty seconds; a
        // strict comparison would want thirty-one, and someone who writes 30 beside a device that
        // reports every ten seconds means the third reading, not the fourth.
        if (now - since < TimeSpan.FromSeconds(seconds)) return false;

        // The freshness gate. Maturation is a claim about the present — 'this has been true for the
        // last thirty seconds' — and a pair whose last real judgement is minutes old cannot support
        // it. Without this, a topic that stops sending mid-For matures its own half-finished timer
        // on a tick and rings about a value nobody has seen since: silence would ring as a threshold
        // breach, and silence has its own condition for saying so.
        //
        // An arrival passes it for free, because LastEvaluated is 'now' by the time we get here. The
        // gate therefore only ever bites on a tick, which is the only place it could go wrong.
        return state.LastEvaluated is { } last
            && now - last <= TimeSpan.FromSeconds(_options.FreshnessSeconds);
    }

    private Alert Raise(AlertRule rule, RuleState state, DateTimeOffset now,
                        string reason, double? value, string? sample)
    {
        var alert = new Alert(
            // Task 7's counter, not a Guid. The core is meant to be a function of its inputs: run the
            // same messages through the same rules twice and the second run has to be the first one
            // again, ids included, or a lifecycle test that fails on the build server cannot be read
            // beside the one that passed here.
            Id: NextId(now),
            RuleId: rule.Id,
            RuleName: rule.Name,
            Topic: state.Topic,
            Severity: rule.Severity,
            FiredAt: now,
            LastSeenAt: now,
            ResolvedAt: null,
            ResolvedBy: null,
            MutedUntil: state.MutedUntil,
            Count: 1,
            Reason: reason,
            Value: value,
            Sample: sample,
            Actions: rule.Actions);

        state.Active = alert;

        // The clock is spent. From here TrueSince belongs to the way out, and nothing is standing on
        // it yet — Task 9 is what puts something there.
        state.TrueSince = null;
        return alert;
    }

    /// <summary>
    /// The sentence the alert carries, written once at the moment it rings and never rewritten:
    /// Reason says why this alert exists, not what the value is doing now.
    /// </summary>
    private static string ReasonFor(AlertRule rule, in EvalContext context)
    {
        var head = Describe(rule.Condition, context);
        return rule.For is { } seconds ? $"{head} for {seconds}s" : head;
    }

    private static string Describe(AlertCondition condition, in EvalContext context) => condition switch
    {
        // Two shapes for every value condition: with the number when a message brought one ("94.2 >
        // 90"), and without when a tick did the maturing and there is no number to name ("above 90").
        ThresholdCondition t => context.Number is { } n
            ? $"{Number(n)} {Symbol(t.Op)} {Number(t.Value)}"
            : $"{Word(t.Op)} {Number(t.Value)}",
        BandCondition b => context.Number is { } n
            ? $"{Number(n)} {(b.Inside ? "inside" : "outside")} {Number(b.Low)}..{Number(b.High)}"
            : $"{(b.Inside ? "inside" : "outside")} {Number(b.Low)}..{Number(b.High)}",
        PatternCondition p => p.Negate ? $"no match for /{p.Regex}/" : $"matched /{p.Regex}/",
        OneOfCondition o => o.Negate ? "not an accepted value" : "an accepted value",
        SilenceCondition s => $"no message for {s.After}s",
        AllCondition => "every condition held",
        AnyCondition => "one of the conditions held",
        _ => "the condition held",
    };

    // Invariant, and trimmed: this string goes into a webhook body and into an MQTT payload, and a
    // Turkish decimal comma in either is a number the endpoint cannot parse.
    private static string Number(double value)
        => value.ToString("0.####", System.Globalization.CultureInfo.InvariantCulture);

    private static string Symbol(ThresholdOp op) => op switch
    {
        ThresholdOp.Gt => ">",
        ThresholdOp.Gte => ">=",
        ThresholdOp.Lt => "<",
        ThresholdOp.Lte => "<=",
        ThresholdOp.Eq => "==",
        _ => "!=",
    };

    private static string Word(ThresholdOp op) => op switch
    {
        ThresholdOp.Gt => "above",
        ThresholdOp.Gte => "at or above",
        ThresholdOp.Lt => "below",
        ThresholdOp.Lte => "at or below",
        ThresholdOp.Eq => "equal to",
        _ => "not equal to",
    };

    /// <summary>A context with no message behind it: what a tick knows about a pair.</summary>
    private static EvalContext Blank(RuleState state, DateTimeOffset now)
        => new(state.Topic, Text: null, Number: null, now, state.LastSeen, state.Window);

    // Four kilobytes, matching the spec's ceiling. The AlertDto cuts it to 256 bytes again on the
    // way out; keeping the long one here is what makes a webhook body worth reading.
    private const int SampleLimit = 4096;

    private static string? Sample(MqttMessage message)
        => message.Payload.Length <= SampleLimit ? message.Payload : message.Payload[..SampleLimit];

    /// <summary>
    /// The one condition that decides a pair's next state change, and which way it has to come out.
    /// </summary>
    private readonly record struct Edge(AlertCondition Condition, bool WantTrue);

    /// <summary>
    /// A pair is either quiet or ringing, and each state has exactly one way out of it.
    ///
    /// Quiet: the rule's own condition going true. Ringing: Clear going true, or — when the rule has
    /// no Clear — the fire condition going false. Written as one edge rather than as two flags
    /// because the For maturation, the freshness gate and the resolve decision are then the same
    /// three lines of arithmetic instead of two copies that drift apart. RuleState.TrueSince holds
    /// since when this edge has stood without a break, whichever of the three it currently is.
    ///
    /// Clear is reached only through this method, which is what keeps the spec's promise that it is
    /// judged only while an alarm is active: a hysteresis condition is usually true long before
    /// anything is wrong, and judging it early would fill TrueSince with a truth that belongs to a
    /// state the pair is not in.
    ///
    /// Edge.Condition is non-nullable, which is the other reason this is a type rather than two
    /// flags: AlertRule.Clear is an AlertCondition?, and every call site that reached past it into
    /// the evaluator would otherwise be a CS8604 waiting to happen.
    /// </summary>
    private static Edge PendingFor(AlertRule rule, RuleState state)
        => state.Active is null    ? new Edge(rule.Condition, WantTrue: true)
         : rule.Clear is not null  ? new Edge(rule.Clear, WantTrue: true)
         :                           new Edge(rule.Condition, WantTrue: false);

    private void OnArrival(AlertRule rule, RuleState state, MqttMessage message,
                           in EvalContext context, DateTimeOffset now, List<Alert> raised)
    {
        var edge = PendingFor(rule, state);
        var verdict = _evaluator.Evaluate(edge.Condition, context);

        if (verdict is Verdict.Skipped)
        {
            // Neither confirms nor breaks — for the way out as much as the way in. A hysteresis
            // condition that cannot be judged must not clear an alarm by default; an endpoint told
            // 'back to normal' because a field went missing is worse than one told nothing.
            state.Skipped++;
            return;
        }

        state.Evaluated++;
        state.LastEvaluated = now;

        var holds = (verdict is Verdict.True) == edge.WantTrue;
        if (holds)
            state.TrueSince ??= now;
        else
            state.TrueSince = null;

        if (state.Active is not null)
        {
            // Still in the state that rang: the way out does not hold. One alert per (rule, topic) —
            // it only gets louder. Under a Clear this counts every message that stayed on the wrong
            // side of the clearing line, which is the same reading as 'triggered again'.
            if (!holds)
                state.Active = state.Active with { LastSeenAt = now, Count = state.Active.Count + 1 };
            return;
        }

        if (Matured(rule, state, now) && !Withheld(state, now))
            raised.Add(Raise(rule, state, now, ReasonFor(rule, context), context.Number, Sample(message)));
    }

    private void OnPairTick(AlertRule rule, RuleState state, DateTimeOffset now,
                            List<Alert> raised, List<Alert> resolved)
    {
        if (state.Active is { } active)
        {
            if (state.TrueSince is null) return;

            // Resolving is the tick's alone. A late ring is a missed breach and has to happen at the
            // arrival; a late resolve is only a late resolve. Putting the decision here is what caps
            // a flapping pair at one state change a second however fast it is judged — and the spec
            // rejected a symmetric For on this edge for exactly that reason: the ceiling is already
            // one a second, and a second mechanism would only be a second thing to explain.
            var closed = active with { ResolvedAt = now, ResolvedBy = "clear" };
            state.Active = null;
            state.TrueSince = null;
            state.CooldownUntil = now + Cooldown(rule);
            Remember(closed);
            resolved.Add(closed);
            return;
        }

        if (state.TrueSince is null) return;
        if (!Matured(rule, state, now) || Withheld(state, now)) return;

        raised.Add(Raise(rule, state, now, ReasonFor(rule, Blank(state, now)), value: null, sample: null));
    }

    /// <summary>A pair that is judged exactly as before but is not allowed to ring yet.</summary>
    // Both terms are nullable on the left, so a pair that is neither muted nor cooling compares false
    // and is free to ring. The mute term is written here and does not survive: Task 12, which is what
    // finally gives MutedUntil a writer, takes it out again, because a mute is a decision about
    // telling and not about watching — folding it in here would make 'stop telling me' quietly mean
    // 'stop watching'. It is spelt out in the shape Task 12 replaces so that the removal reads as the
    // decision it is, rather than as a line nobody ever wrote.
    private static bool Withheld(RuleState state, DateTimeOffset now)
        => state.MutedUntil > now || state.CooldownUntil > now;

    /// <summary>
    /// How long a pair stays quiet after it has cleared.
    ///
    /// Null means one second, not none. An alarm that does not multiply still leaves the
    /// ring-clear-ring cycle open: a signal walking either side of its threshold would change state
    /// once per tick forever. A zero default would have shipped the only defence against that
    /// switched off, and the user who most needs it is the one who has not thought about it yet.
    /// </summary>
    private TimeSpan Cooldown(AlertRule rule)
        => TimeSpan.FromSeconds(rule.Cooldown ?? _options.DefaultCooldownSeconds);

    /// <summary>
    /// The engine's only writer of _history, and it stays the only one: every later task that closes
    /// an alert — a ceiling refusing a pair, a save dropping a rule that was ringing — comes through
    /// here, so the depth ceiling is enforced in one place rather than in whichever copy was edited
    /// last.
    /// </summary>
    private void Remember(Alert alert)
    {
        // Newest first, because the panel reads from the top. This list is a session's tail and not
        // a record — the record is whatever the webhook's endpoint keeps, which is why the history
        // is deliberately absent from alert-state.json.
        _history.Insert(0, alert);
        if (_history.Count > _options.HistoryDepth)
            _history.RemoveRange(_options.HistoryDepth, _history.Count - _options.HistoryDepth);
    }
}
