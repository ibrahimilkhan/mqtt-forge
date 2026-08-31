using System.Text.RegularExpressions;
using System.Globalization;
using MqttForge.Application.Alerts.Conditions;
using MqttForge.Application.Alerts.Statistics;
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

    /// <summary>What a resolved alert says when the plant has moved rather than come back.</summary>
    // Its own sentence and not "clear", because nothing cleared. The readings that rang the alarm
    // are now the readings the fence is drawn from, and an endpoint told "clear" would record that
    // the boiler came back to seventy when the boiler is at ninety-five and staying there.
    public const string NewLevelAccepted = "new level accepted";

    public EngineOutcome OnMessage(MqttMessage message, DateTimeOffset now)
    {
        if (message.Topic.StartsWith(_options.TopicPrefix, StringComparison.Ordinal))
            return EngineOutcome.Empty;

        if (message.Replay) return EngineOutcome.Empty;

        // Allocated only once a rule actually matches, so the common case — a topic nobody wrote
        // a rule for — still costs nothing and still returns the shared Empty. Resolved is new
        // here: until this task nothing on the arrival path could end an alarm, and accepting a
        // new level does exactly that.
        List<Alert>? raised = null;
        List<Alert>? resolved = null;

        foreach (var rule in _rules)
        {
            if (!rule.Enabled) continue;
            if (!TopicFilterMatch.Matches(rule.Filter, message.Topic)) continue;

            // Set aside for this session. A condition that threw once will throw on the next
            // thousand messages, and a pattern that has timed out ten times running will time out
            // on the eleventh — at fifty milliseconds of a single-threaded engine each time.
            if (IsFaulted(rule.Id)) continue;

            // Track is the only door a pair comes into being through, and it is allowed to say
            // no. A refused topic is not evaluated at all — not cheaply, not partly. It is not a
            // pair.
            var state = Track(rule, message.Topic);
            if (state is null) continue;

            OnMatch(rule, state, message, now, raised ??= [], resolved ??= []);
        }

        return Outcome(raised is { Count: > 0 } ? raised : null,
                       resolved is { Count: > 0 } ? resolved : null);
    }
    /// <summary>One matched (rule, topic) pair, for one arrival.</summary>
    // Lifted out of OnMessage's loop because the order of the three things it does is the whole
    // of the outlier task, and an order that matters should be readable in one screen rather than
    // inside a foreach over the rule set.
    private void OnMatch(AlertRule rule, RuleState state, MqttMessage message, DateTimeOffset now,
                         List<Alert> raised, List<Alert> resolved)
    {
        // The message's own stamp, not the engine's: a queued burst must not collapse onto
        // the moment the pump emptied it.
        state.LastSeen = message.ReceivedAt;

        var found = PayloadValue.TryExtract(message.Payload, rule.Field, out var text);
        var number = found ? PayloadValue.AsReading(text) : null;

        // The pair goes on the context, and this is one of the two places it can: a context is
        // built here and in Blank, and nowhere else. Attaching it further down, inside
        // EvaluateGuarded, would give the evaluator a local copy and leave ReasonFor holding the
        // one this line made — so every alert the two edge conditions raise would be described
        // without the two names that are the whole news in it.
        var context = new EvalContext(
            message.Topic, found ? text : null, number, now, state.LastSeen, state.Window, state);

        OnArrival(rule, state, message, context, now, raised);

        // And only now the ring, which is the reversal the outlier task exists for. Before it, the
        // reading went in first and every fence drawn afterwards had already been widened by the
        // reading it was about to judge — so a boiler that steps to ninety-five would ring once
        // and then teach the rule that ninety-five is normal, fifty readings at a time.
        if (state.Window is { } window && number is { } value)
            Record(rule, state, window, new Reading(message.ReceivedAt.UtcTicks, value), now, resolved);
    }

    /// <summary>
    /// Whether this reading joins the run, and what it means when a run of them does not.
    /// </summary>
    private void Record(AlertRule rule, RuleState state, TopicWindow window,
                        in Reading reading, DateTimeOffset now, List<Alert> resolved)
    {
        if (Outlier.Rejects(state.Plan.Outliers, window, reading.Value))
        {
            state.OutlierRun++;

            // Still a burst as far as anyone can tell. The reading is dropped, the ring goes on
            // describing the run this reading is unlike, and the alarm — which is standing on
            // exactly that comparison — goes on standing.
            if (state.OutlierRun < state.Plan.NewLevelAfter) return;

            // A quarter of the ring in a row is not a burst. The plant has moved, and a rule that
            // could never say so would ring until somebody deleted it, which is how a panel
            // teaches the people watching it to stop looking.
            window.Clear();
            state.OutlierRun = 0;

            if (state.Active is { } active)
            {
                var closed = active with { ResolvedAt = now, ResolvedBy = NewLevelAccepted };

                // The clock is spent and the pair goes quiet for its cooldown, exactly as it does
                // on the tick's own resolve. The ring is empty, so nothing could fire for another
                // twenty readings anyway; the cooldown is here so that every resolution in this
                // engine leaves the pair in the same state, whichever door it left by.
                state.TrueSince = null;
                state.CooldownUntil = now + Cooldown(rule);

                // Close, never `state.Active = null`: Close is the only place the system-wide
                // count of open alerts comes back down, and Announce is the only place the
                // decision to tell anybody is made.
                Close(state, closed);
                Announce(state, closed, resolved, now);
            }
        }
        else
        {
            // A reading that belongs ends the run, however long it was. A step interrupted by one
            // ordinary reading is not yet somewhere the plant lives.
            state.OutlierRun = 0;
        }

        window.Add(reading);
    }
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

    private Alert? Raise(AlertRule rule, RuleState state, DateTimeOffset now,
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

        // The only door an alert opens through. Null when the system ceiling is full: the pair
        // goes on being judged exactly as before, and the refusal is counted rather than dropped.
        if (TryOpen(state, rule, alert, now) is null) return null;

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

        // The measure goes in the sentence because there is no other way to read the alert. "95
        // is an outlier" invites exactly one question — by what standard — and the person asking
        // it is looking at a webhook body in another system, with the rule nowhere in sight.
        OutlierCondition o => context.Number is { } n
            ? $"{Number(n)} is an outlier ({Measure(o)})"
            : $"an outlier ({Measure(o)})",

        SilenceCondition s => $"no message for {s.After}s",

        // Both names, because one of them is the news. "the readings stopped being normal and
        // became uniform" is a sentence an operator can act on; "the distribution changed" is one
        // they have to come and look up, and the alert is on its way out of the process by then —
        // into a webhook body, an MQTT payload and somebody's phone.
        //
        // Read off the pair rather than off the condition, which carries no names at all: the rule
        // says 'tell me when this changes', and what it changed from is a fact about the topic.
        DistributionShiftCondition => context.State is { ConfirmedFit: { } was, CandidateFit: { } now }
            ? $"the readings stopped being {Word(was)} and became {Word(now)}"
            : "the readings changed distribution",
        ShapeChangeCondition => context.State is { ConfirmedShape: { } was, CandidateShape: { } now }
            ? $"the signal stopped being {Word(was)} and became {Word(now)}"
            : "the signal changed shape",

        // The rule's own sentence, without the measurement. Reason is written once at the moment an
        // alert rings and the measurement is a window's worth of arithmetic; doing it again here,
        // on the firing path, to put one number into a string was not worth what it costs — and the
        // number is already on the alert, in Value, for anything that wants it.
        PulseCondition p => $"{Word(p.Metric)} {Symbol(p.Op)} {Number(p.Value)}",

        AllCondition => "every condition held",
        AnyCondition => "one of the conditions held",
        _ => "the condition held",
    };

    /// <summary>How the fence was drawn, in the words the editor uses for it.</summary>
    // Outlier.KOf and not the record's own K, so that a rule which left k unset says the number
    // the engine actually used rather than a nought that would read as no fence at all.
    private static string Measure(OutlierCondition condition) =>
        $"{(condition.Method is OutlierMethod.Sigma ? "sigma" : "tukey")}, k {Number(Outlier.KOf(condition))}";
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
    // The pair goes on it, like it goes on the arrival context. Describe reads ConfirmedFit and
    // CandidateFit off it to name both sides of a change, and a tick that matured an edge writes
    // the same sentence an arrival would have.
    private static EvalContext Blank(RuleState state, DateTimeOffset now)
        => new(state.Topic, Text: null, Number: null, now, state.LastSeen, state.Window, state);

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
        => state.Active is null ? new Edge(rule.Condition, WantTrue: true)
         : rule.Clear is not null ? new Edge(rule.Clear, WantTrue: true)
         : new Edge(rule.Condition, WantTrue: false);

    private void OnArrival(AlertRule rule, RuleState state, MqttMessage message,
                           in EvalContext context, DateTimeOffset now, List<Alert> raised)
    {
        var edge = PendingFor(rule, state);
        var verdict = EvaluateGuarded(rule, state, edge.Condition, context);

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

        if (Matured(rule, state, now) && !Withheld(state, now)
            && Raise(rule, state, now, ReasonFor(rule, context), context.Number, Sample(message)) is { } alarm)
            Announce(state, alarm, raised, now);
    }

    /// <summary>A pair that is judged exactly as before but is not allowed to ring yet.</summary>
    // Both terms are nullable on the left, so a pair that is neither muted nor cooling compares false
    // and is free to ring. The mute term is written here and does not survive: Task 12, which is what
    // finally gives MutedUntil a writer, takes it out again, because a mute is a decision about
    // telling and not about watching — folding it in here would make 'stop telling me' quietly mean
    // 'stop watching'. It is spelt out in the shape Task 12 replaces so that the removal reads as the
    // decision it is, rather than as a line nobody ever wrote.
    // Cooldown only. A muted pair is judged, fires, and counts exactly as it would have — what a
    // mute stops is the telling, and that is Announce's job. Folding the mute in here would make
    // "stop telling me" mean "stop watching", and the alarm would silently not be there when the
    // mute lapsed.
    private static bool Withheld(RuleState state, DateTimeOffset now)
        => state.CooldownUntil > now;

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

    // Whether the last tick found the link up. Starts true, which is the awkward-looking half of
    // this: an engine that has just been built has nothing an outage could have stopped, and treating
    // its first tick as a return would pull every pair's clock forward — wiping a For that an arrival
    // a moment earlier had already started. Resume is for coming back, and you cannot come back
    // before you have been anywhere.
    private bool _linkWasUp = true;

    public EngineOutcome OnTick(DateTimeOffset now, bool connected)
    {
        // A mute that expired at the top of this second is over for everything the tick does
        // below, and for the arrivals that follow it.
        SweepMutes(now);

        if (connected && !_linkWasUp)
            Resume(now);
        _linkWasUp = connected;

        var raised = new List<Alert>();
        var resolved = new List<Alert>();

        // A flat walk. The round-robin cursor and the 200 ms budget belong to the ceilings task; both
        // of them replace this loop without touching anything below it. Two lists a second is nothing
        // — the message path is where allocation has to be counted.
        foreach (var (key, state) in _pairs)
        {
            // _byId, not _rules: this asks "which rule is this pair's, and is it live", which is the
            // dictionary's question. _rules is the file's order and answers the panel's.
            if (!_byId.TryGetValue(key.RuleId, out var rule) || !rule.Enabled) continue;

            // Set aside for this session. A condition that threw once will throw on the next
            // thousand messages, and a pattern that has timed out ten times running will time out
            // on the eleventh — at fifty milliseconds of a single-threaded engine each time.
            if (IsFaulted(rule.Id)) continue;

            // While the link is down a tick brings no news, so nothing is judged and nothing matures.
            // Without this, the instant the broker drops every silence rule in the set goes true
            // together and the user gets a hundred webhooks, all describing one event that is already
            // reported on its own.
            if (connected)
                JudgeOnTick(rule, state, now);

            OnPairTick(rule, state, now, connected, raised, resolved);
        }

        return raised.Count == 0 && resolved.Count == 0
            ? EngineOutcome.Empty
            : new EngineOutcome(raised, resolved);
    }

    /// <summary>
    /// What a tick can judge on its own: a condition that needs no message.
    ///
    /// The pending edge is evaluated against a context with no text and no number, which makes this
    /// one method serve every condition type without a special case for silence. A threshold or a
    /// pattern comes back Skipped — it has nothing to read — and Skipped neither confirms nor breaks,
    /// so a tick leaves value rules exactly as the last arrival left them. A silence condition reads
    /// LastSeen and Now, both of which a tick has, and answers properly.
    /// </summary>
    private void JudgeOnTick(AlertRule rule, RuleState state, DateTimeOffset now)
    {
        var edge = PendingFor(rule, state);
        var verdict = EvaluateGuarded(rule, state, edge.Condition, Blank(state, now));

        // Not counted as a skip. The Skipped counter is a count of messages the rule could not read,
        // and the panel would be telling the user something untrue if a quiet second went into it.
        if (verdict is Verdict.Skipped) return;

        var holds = (verdict is Verdict.True) == edge.WantTrue;
        if (holds)
            state.TrueSince ??= now;
        else
            state.TrueSince = null;

        state.LastEvaluated = now;
    }

    private void OnPairTick(AlertRule rule, RuleState state, DateTimeOffset now, bool connected,
                            List<Alert> raised, List<Alert> resolved)
    {
        if (state.Active is { } active)
        {
            if (state.TrueSince is null) return;

            // Resolving is allowed even while the link is down. An edge decided by real data before
            // the drop is not made doubtful by the drop, and holding the resolve back would leave an
            // endpoint waiting on a 'resolved' the outage has no business delaying. It is the
            // deciding that needs a live link, not the reporting.
            var closed = active with { ResolvedAt = now, ResolvedBy = "clear" };
            state.TrueSince = null;
            state.CooldownUntil = now + Cooldown(rule);

            // Through Close, which is the only place an alert leaves the active set — and so the
            // only place the system-wide count comes back down. Writing state.Active = null here
            // would free the pair without freeing the slot, and the ceiling would ratchet shut one
            // alarm at a time until nothing could ever ring again.
            Close(state, closed);
            Announce(state, closed, resolved, now);
            return;
        }

        if (!connected) return;
        if (state.TrueSince is null) return;
        if (Matured(rule, state, now) && !Withheld(state, now)
            && Raise(rule, state, now, ReasonFor(rule, Blank(state, now)), null, null) is { } alarm)
            Announce(state, alarm, raised, now);
    }

    /// <summary>
    /// Opens the pair a wildcard could never open.
    ///
    /// A silence rule can normally only miss a topic it has heard from: with 'sensors/+/temp' the
    /// engine does not know which sensors are supposed to exist, and this tool keeps no inventory.
    /// But a filter with no '+' and no '#' is not a filter — it is the topic's own name, and the rule
    /// then says something checkable without a single message ever arriving: this device has not
    /// spoken. That is the most-wanted alert of the lot and it comes free.
    ///
    /// The pair's clock starts now rather than at nothing, so a rule saved a moment ago gives the
    /// device its 'after' seconds to speak before calling it dead; Resume pulls it forward with all
    /// the others when the link returns. LastSeen therefore holds an arming moment rather than an
    /// arrival for these pairs, which is the one place its name is generous — and the right generous:
    /// it is the moment from which this rule has been listening.
    /// </summary>
    private void Arm(IReadOnlyList<AlertRule> rules, DateTimeOffset now)
    {
        foreach (var rule in rules)
        {
            if (!rule.Enabled) continue;
            if (TopicFilterMatch.HasWildcard(rule.Filter)) continue;
            if (!CanRingWithoutData(rule.Condition)) continue;

            // A rule left alone keeps its clock. Saving the whole list must not restart the silence
            // timer of a rule nobody touched — the same promise the reconciliation makes for
            // cooldowns.
            // Through the same door as an arrival, so the ceilings count an armed pair exactly as
            // they count one a message opened. A refusal here is the same refusal: the rule keeps
            // what it holds and the panel says how much it had to leave out.
            var armed = Track(rule, rule.Filter);
            if (armed is null) continue;
            if (armed.LastSeen is null) armed.LastSeen = now;
        }
    }

    /// <summary>
    /// Whether a tick alone could ever make this condition true — that is, whether silence is in it.
    /// Generous on purpose inside 'all': arming a pair whose composite will only ever come back
    /// Skipped costs one dictionary entry and rings nothing, while being strict here would silently
    /// drop the case the user was writing the rule for.
    /// </summary>
    private static bool CanRingWithoutData(AlertCondition condition) => condition switch
    {
        SilenceCondition => true,
        AllCondition all => all.Of.Any(CanRingWithoutData),
        AnyCondition any => any.Of.Any(CanRingWithoutData),
        _ => false,
    };

    /// <summary>
    /// The link is back at the same endpoint. Every clock the outage stopped is pulled to this moment.
    /// </summary>
    private void Resume(DateTimeOffset now)
    {
        foreach (var state in _pairs.Values)
        {
            // So the outage itself never reads as silence.
            state.LastSeen = now;

            // A For that was half-finished when the link dropped starts over: 'true for the last
            // thirty seconds' cannot be claimed across a gap nobody watched. An alarm that is already
            // ringing keeps its TrueSince — that one belongs to the way out, and dropping it would
            // hold open an alarm the data had already cleared.
            if (state.Active is null)
                state.TrueSince = null;

            // And the freshness gate starts from nothing rather than from a judgement made before the
            // gap. Windows, active alarms, mutes and cooldowns are all left alone: a sensor's history
            // does not become meaningless because a socket blinked.
            state.LastEvaluated = null;
        }
    }

    // A mute longer than a day is disabling the rule, and the editor says so. The core clamps
    // rather than trusts: the validator lives in Api, and a record can reach this method from a
    // state file that has been through a text editor as well as from a panel that has not.
    public const int MaxMuteMinutes = 1440;

    /// <summary>
    /// Silences one (rule, topic) pair for <paramref name="minutes"/> minutes.
    /// Zero or less lifts an existing mute.
    /// </summary>
    public EngineOutcome Mute(string ruleId, string topic, int minutes, DateTimeOffset now)
    {
        // A pair the engine has never seen has nothing to silence, and this returns rather than
        // throws: the console mutes from a row it drew a moment ago, and by the time the record
        // has crossed the channel the rule may have been edited out from under it. Creating the
        // pair here was considered and rejected outright — it would be a door straight past
        // MaxTopicsPerRule, which the arrival path is careful to hold shut.
        if (!_pairs.TryGetValue((ruleId, topic), out var state))
            return EngineOutcome.Empty;

        var until = minutes <= 0
            ? (DateTimeOffset?)null
            : now.AddMinutes(Math.Min(minutes, MaxMuteMinutes));

        // The mute lives on the pair and never on the alert. That is the point of it: an alert
        // that clears and fires again an hour later is a different Alert with a different Id, and
        // a mute the user set on the boiler has to outlive that or it silences almost nothing.
        state.MutedUntil = until;

        // The alert carries a copy so the panel can fade the row and print "muted until 09:30"
        // without having to join two lists to find out. It is a label, not the state.
        if (state.Active is { } active)
            state.Active = active with { MutedUntil = until };

        // Muting raises and resolves nothing. The return type is here so the pump can treat every
        // record on its channel the same way. Re-announcing a still-active alert when a mute is
        // lifted was considered and rejected: it would push an hour-old FiredAt to the top of the
        // console's list as though it had just happened, and the snapshot already carries the row.
        return EngineOutcome.Empty;
    }

    // At exactly MutedUntil the pair speaks again. The panel's label reads "muted until 09:30",
    // and 09:30 is when it is over; a <= here would make that label wrong by one tick, and every
    // other deadline in this engine — Cooldown, For — is read the same way.
    private static bool IsMuted(RuleState state, DateTimeOffset now)
        => state.MutedUntil is { } until && now < until;

    // The one door every raise and every resolve leaves by. Muting closes all four channels —
    // screen, sound, webhook, publish — and the outcome is what feeds all four, so one choke
    // point here is one place to be right; four scattered guards would be four places for the
    // fifth channel to be forgotten when it arrives.
    //
    // Note what this deliberately does not do: the suppressed alert is still in the snapshot's
    // Active list, and the snapshot is the authority for what the panel draws. The outcome is
    // only ever the authority for what gets delivered.
    private static void Announce(RuleState state, Alert alert, List<Alert> into, DateTimeOffset now)
    {
        if (IsMuted(state, now)) return;
        into.Add(alert);
    }

    // Housekeeping for the snapshot's muted list, which has no clock of its own — Snapshot() is
    // pure by construction and cannot ask whether a deadline has passed. So the tick clears
    // deadlines that have, and an expired mute can linger in the list for at most one second.
    //
    // This walks every pair rather than a side list of muted ones: a side list is a second
    // collection to keep in step with every pair removal, in exchange for skipping a null check
    // per pair. The tick's round-robin cursor exists to bound condition *evaluation*, and reading
    // one nullable field is not one.
    private void SweepMutes(DateTimeOffset now)
    {
        foreach (var state in _pairs.Values)
        {
            if (state.MutedUntil is not { } until || now < until) continue;

            state.MutedUntil = null;
            if (state.Active is { } active)
                state.Active = active with { MutedUntil = null };
        }
    }

    public AlertSnapshot Snapshot()
    {
        var active = new List<Alert>();
        var muted = new List<MutedPair>();
        var warming = new List<WarmingPair>();
        var seen = new Dictionary<string, (int Topics, long Evaluated, long Skipped)>(StringComparer.Ordinal);

        // Which rules judge statistically, worked out once for the whole walk rather than once per
        // pair. The question is about the rule's condition tree, and a '#' rule has a thousand
        // pairs asking it — a tree walk each would make the panel's refresh cost more than the
        // judging does.
        HashSet<string>? statistical = null;
        foreach (var rule in _rules)
            if (Statistical.Judges(rule.Condition) || Statistical.Judges(rule.Clear))
                (statistical ??= new HashSet<string>(StringComparer.Ordinal)).Add(rule.Id);

        // One pass. Everything below is a projection of the pairs, and walking twenty thousand of
        // them three times to build three lists costs three times what it needs to on exactly the
        // machine that can least afford it.
        foreach (var state in _pairs.Values)
        {
            if (state.Active is { } alert) active.Add(alert);
            if (state.MutedUntil is { } until) muted.Add(new MutedPair(state.RuleId, state.Topic, until));

            // Only the rules that read history. Every pair holds a ring, so a threshold rule's
            // pairs would otherwise all report themselves as filling a window nothing is going to
            // read — a row about something that is not happening, on the panel whose whole job is
            // telling a quiet rule from a broken one.
            if (statistical?.Contains(state.RuleId) == true && Statistical.Warming(state.Window))
                warming.Add(new WarmingPair(state.RuleId, state.Topic,
                                            Statistical.Have(state.Window), Statistical.EnoughToJudge));

            seen.TryGetValue(state.RuleId, out var row);
            seen[state.RuleId] = (row.Topics + 1, row.Evaluated + state.Evaluated, row.Skipped + state.Skipped);
        }

        // Worst first, oldest first within a level. Sorted here rather than in the browser because
        // a dictionary's order is not a promise, and a list that reshuffles between two snapshots
        // meaning the same thing reads as activity.
        active.Sort(static (a, b) =>
            a.Severity != b.Severity
                ? b.Severity.CompareTo(a.Severity)
                : a.FiredAt.CompareTo(b.FiredAt));

        muted.Sort(static (a, b) =>
        {
            var byRule = string.CompareOrdinal(a.RuleId, b.RuleId);
            return byRule != 0 ? byRule : string.CompareOrdinal(a.Topic, b.Topic);
        });

        // Sorted before it is cut, so that the hundred shown are always the same hundred while they
        // are warming rather than whichever hundred the dictionary happened to hand over this
        // second. A '#' rule meeting a fresh broker is a thousand of these at once and none of them
        // is news for more than twenty readings, so the list is capped and the panel says nothing
        // more about the rest — they are a moment old and about to stop existing.
        warming.Sort(static (a, b) =>
        {
            var byRule = string.CompareOrdinal(a.RuleId, b.RuleId);
            return byRule != 0 ? byRule : string.CompareOrdinal(a.Topic, b.Topic);
        });

        if (warming.Count > MaxWarmingShown)
            warming.RemoveRange(MaxWarmingShown, warming.Count - MaxWarmingShown);

        // Walked in the rule set's own order — _rules, the file-order list, not _byId — so the
        // panel's diagnostics line up with the editor's list rather than with a hash table's
        // internals, and so a disabled rule still gets a row. Off has to look different from
        // absent when someone is asking why nothing has gone off all week.
        var diagnostics = new List<RuleDiagnostic>(_rules.Count);
        var capped = new List<CappedRule>();
        foreach (var rule in _rules)
        {
            // Never TallyOf here: this is a read, and ReconcileDiagnostics has already made a
            // tally for every rule in the set.
            _tallies.TryGetValue(rule.Id, out var tally);
            seen.TryGetValue(rule.Id, out var row);

            // A rule with no pairs is a row of zeroes and not a missing row. "Matched no topic" is
            // the answer to the only question this panel exists for, and a rule that is silently
            // absent looks exactly like a rule that is quietly working.
            diagnostics.Add(new RuleDiagnostic(
                rule.Id,
                row.Topics,
                row.Evaluated,
                row.Skipped,
                tally?.LastFiredAt,
                Faulted: _faults.ContainsKey(rule.Id),
                FaultReason: _faults.GetValueOrDefault(rule.Id)));

            if (tally is { Refused.Count: > 0 })
                capped.Add(new CappedRule(rule.Id, tally.Refused.Count));
        }

        return new AlertSnapshot(active, [.. _history], muted, diagnostics, _dropped, _suppressed,
                                 capped, warming);
    }

    // History only. The active alerts are not history — they are the present, and a user clearing
    // a list of things that finished should not find the thing still happening has gone with them.
    public void ClearHistory() => _history.Clear();

    // Sum of every allocated ring's capacity, in readings. Capacity and not fill: the budget is
    // about the sixty-four megabytes the rings occupy, and a ring occupies them from the moment
    // it is made.
    private int _readings;

    // Alerts the active ceiling would not let open. Counted rather than dropped in silence — the
    // same bargain messagesDropped struck, for the same reason: an engine that quietly stops
    // alarming at a thousand is indistinguishable from a plant that quietly went quiet. This is
    // the only declaration of the field; Task 7 passed a literal 0 in its place because there was
    // nothing yet to refuse an alert.
    private int _suppressed;

    // How many pairs currently hold an open alert. Kept as a running count because the fire path
    // asks on every arrival, and answering by walking twenty thousand pairs each time would make
    // the ceiling more expensive than the thing it protects against.
    private int _active;

    // The queue in front of the core drops messages under load; the core is pure and holds no
    // queue, so it cannot see that happen. The transport hands it the running total and the
    // snapshot carries it out again.
    private int _dropped;

    /// <summary>The transport's running count of messages the queue in front of this engine dropped.</summary>
    public void SetDropped(int dropped) => _dropped = dropped;

    private readonly Dictionary<string, RuleTally> _tallies = new(StringComparer.Ordinal);

    // What each rule's fingerprint was at the last save. Declared here because this is the first
    // task that reads it; Task 15's rewritten SetRules is what fills it once reconciliation
    // exists, and it must consume this declaration rather than write a second one (CS0102).
    // Until then the fill at the end of ReconcileDiagnostics below keeps it true.
    private readonly Dictionary<string, string> _hashes = new(StringComparer.Ordinal);

    // What a rule has seen, as against what one of its pairs has seen. Topics, evaluations and
    // skips live on the pairs and are summed at snapshot time; these cannot, because no single
    // pair owns them — and because a pair that was refused never existed to own anything.
    private sealed class RuleTally
    {
        public int Topics;
        public DateTimeOffset? LastFiredAt;

        // Whether the rule was switched on at the last save. The one bit of a rule that matters
        // to the counters and is deliberately outside ConfigHash, and the one bit nothing else
        // survives a save holding: _byId has already been rebuilt from the rules that just
        // arrived by the time the diagnostics are reconciled.
        public bool Enabled = true;

        // Distinct topics a ceiling refused, not refusals. Bounded by the same number as the
        // topics themselves: a '#' rule on a six-thousand-topic broker would otherwise grow the
        // very memory the ceiling exists to bound, one name at a time. Past that the count stops
        // climbing and understates — a rule this far over its ceiling needs to be told, not
        // measured.
        public readonly HashSet<string> Refused = new(StringComparer.Ordinal);

        // Topics is deliberately untouched: it is a live count of pairs, not a tally of things
        // that happened, and an edit that keeps the pairs has to keep the number that says so.
        // Enabled is untouched for the opposite reason — it is not a count at all, it is the
        // memory that decides whether there is anything to reset next time.
        public void Reset()
        {
            LastFiredAt = null;
            Refused.Clear();
        }
    }

    private RuleTally TallyOf(string ruleId)
    {
        if (!_tallies.TryGetValue(ruleId, out var tally))
            _tallies[ruleId] = tally = new RuleTally();
        return tally;
    }

    /// <summary>The only way a (rule, topic) pair comes into being. Null when a ceiling said no.</summary>
    private RuleState? Track(AlertRule rule, string topic)
    {
        var key = (rule.Id, topic);
        if (_pairs.TryGetValue(key, out var state))
            return state;

        var tally = TallyOf(rule.Id);

        // Worked out before the ceilings are asked, because the third of them is a budget of
        // readings and the number of readings is what this says. Until this task the ring was
        // always DefaultWindow, so a rule asking for a window of two thousand was silently judged
        // on two hundred — and the budget, which the spec writes as Σ(window × topics), was
        // charged for two hundred as well. One number now answers both.
        var plan = WindowPlan.For(rule, _options);

        // Three ceilings, and the order matters only for which one gets the credit. The per-rule
        // one stops a single '#' rule eating a whole broker; the system one stops thirty
        // well-behaved rules doing together what none of them could do alone; the ring budget
        // stops the memory regardless of how the pairs are distributed.
        if (tally.Topics >= _options.MaxTopicsPerRule) return Refuse(tally, topic);
        if (_pairs.Count >= _options.MaxPairs) return Refuse(tally, topic);
        if (_readings + plan.Capacity > _options.MaxReadings) return Refuse(tally, topic);

        // Every pair gets a ring, unconditionally. Handing one out only to the rules whose
        // conditions read history was considered and is now deleted: it made the ring budget a
        // ceiling on a thing that was almost never allocated, and it made a pair that half works
        // — answering thresholds while silently never answering anything windowed. One ceiling
        // with one meaning is worth more than a pair nobody can explain.
        //
        // The size is the rule's own, though, and no longer everyone's. A rule that asked for
        // nothing windowed still gets DefaultWindow, so nothing about the plain rules changes.
        var window = new TopicWindow(plan.Capacity);
        _readings += window.Capacity;
        tally.Topics++;

        state = new RuleState(rule.Id, topic, window) { Plan = plan };
        _pairs[key] = state;
        return state;
    }
    private static RuleState? Refuse(RuleTally tally, string topic)
    {
        if (tally.Refused.Count < 1_000)
            tally.Refused.Add(topic);
        return null;
    }

    /// <summary>The only way an alert becomes active. Null when the ceiling is full.</summary>
    private Alert? TryOpen(RuleState state, AlertRule rule, Alert alert, DateTimeOffset now)
    {
        if (_active >= _options.MaxActiveAlerts)
        {
            _suppressed++;

            // The cooldown is borrowed as a retry damper. Without it, a line stuck at 20 mA and
            // publishing fifty times a second turns 'suppressed' into a message counter, and the
            // panel reports the plant's message rate as a number of alarms it could not raise.
            // The engine's default and not the rule's own Cooldown, deliberately: the ceiling is
            // a property of the system, and a rule that set Cooldown 0 to catch every edge should
            // not get to decide how often the system counts its own refusals.
            state.CooldownUntil = now.AddSeconds(_options.DefaultCooldownSeconds);
            return null;
        }

        _active++;
        state.Active = alert;
        TallyOf(rule.Id).LastFiredAt = now;
        return alert;
    }

    /// <summary>The only way an alert stops being active, whatever resolved it.</summary>
    // Remember does the insertion and the trim; this method exists for the one thing Remember
    // cannot know about — that a slot under the active ceiling has just come free. Task 15's
    // reconciliation must close through here too, or a save that drops a ringing pair leaves the
    // count of open alerts permanently one too high and the ceiling shuts early for ever after.
    private void Close(RuleState state, Alert resolved)
    {
        state.Active = null;
        _active--;
        Remember(resolved);
    }

    /// <summary>Last statement of SetRules, after the rule set and the pairs have been reconciled.</summary>
    private void ReconcileDiagnostics(IReadOnlyList<AlertRule> rules)
    {
        foreach (var rule in rules)
        {
            var tally = TallyOf(rule.Id);
            var hash = ConfigHash.Of(rule);

            // _hashes still holds the previous save's fingerprints at this point, which is the
            // whole reason this runs before SetRules overwrites them.
            var edited = !_hashes.TryGetValue(rule.Id, out var was)
                         || !string.Equals(was, hash, StringComparison.Ordinal)
                         || tally.Enabled != rule.Enabled;
            tally.Enabled = rule.Enabled;
            if (!edited) continue;

            // Enabled is not in the hash, so a toggle keeps the pairs and their rings — and the
            // counters still have to go, because a count that spans a period the rule was not
            // running answers a question nobody asked.
            tally.Reset();
            foreach (var state in _pairs.Values)
            {
                if (!string.Equals(state.RuleId, rule.Id, StringComparison.Ordinal)) continue;
                state.Evaluated = 0;
                state.Skipped = 0;
            }
        }

        var living = rules.Select(r => r.Id).ToHashSet(StringComparer.Ordinal);
        foreach (var id in _tallies.Keys.Where(id => !living.Contains(id)).ToList())
            _tallies.Remove(id);

        // Recount rather than adjust. Reconciliation above may have dropped any number of pairs,
        // each carrying a ring and possibly an open alert, and three counters kept by hand across
        // that would drift the first time a path forgot one. Once per PUT, one pass, no drift.
        foreach (var tally in _tallies.Values) tally.Topics = 0;
        _readings = 0;
        _active = 0;
        foreach (var state in _pairs.Values)
        {
            if (_tallies.TryGetValue(state.RuleId, out var tally)) tally.Topics++;
            _readings += state.Window?.Capacity ?? 0;
            if (state.Active is not null) _active++;
        }

        // The last use of the previous save's fingerprints is above, so this is the moment they
        // can be replaced. Task 15 writes the same map again from SetRules, immediately after
        // calling this method, and from the same ConfigHash.Of over the same rules — identical
        // values, so the two cannot disagree, and this loop can go the day that one lands.
        _hashes.Clear();
        foreach (var rule in rules)
            _hashes[rule.Id] = ConfigHash.Of(rule);
    }

    // ── Fault containment ────────────────────────────────────────────────────────────────────
    //
    // Rule id → why that rule stopped being evaluated this session. Empty on a healthy engine,
    // so the ordinary path pays one dictionary lookup per (rule, message) and nothing else.
    //
    // This is the one place where SignalRMessageNotifier's shape is deliberately not copied. Its
    // pump (SignalRMessageNotifier.cs:71-93) wraps the whole loop in a single catch for
    // OperationCanceledException and nothing else, and DependencyInjection.cs:20 registers it
    // with AddHostedService. Nothing in this repository sets BackgroundServiceExceptionBehavior,
    // so the host default stands, and that default is StopHost: one exception out of that
    // ExecuteAsync takes the whole application down. There it is nearly harmless — everything
    // inside that loop is ours. Here it would not be. This loop runs a regular expression the
    // user typed into a form, walks a JSON document a stranger's broker sent, and ends in a
    // publish that throws NotConnectedException the instant the link drops. Copying that shape
    // would mean the console dies because somebody saved a bad rule.
    //
    // So the exception is caught here, named here, and the rule carrying it is set aside. The
    // pump above stays exactly the shape it borrowed, because nothing reaches it.
    private readonly Dictionary<string, string> _faults = new(StringComparer.Ordinal);

    // The reason is drawn on the panel in a row beside the rule's name. An exception message
    // that quoted a whole payload back would push the rule's name off the line, and the first
    // sentence is always the useful one.
    private const int MaxFaultReason = 200;

    private bool IsFaulted(string ruleId) => _faults.ContainsKey(ruleId);

    private void Fault(AlertRule rule, string reason) =>
        _faults[rule.Id] = reason.Length <= MaxFaultReason ? reason : reason[..MaxFaultReason];

    /// <summary>
    /// Evaluates one condition for one pair and never lets anything past. Returns Skipped for
    /// everything it swallows: a condition that could not be evaluated is not false, and the
    /// three-valued Verdict exists so that this distinction survives the journey back.
    /// </summary>
    private Verdict EvaluateGuarded(
        AlertRule rule, RuleState state, AlertCondition condition, in EvalContext context)
    {
        try
        {
            var verdict = _evaluator.Evaluate(condition, context);

            // Any answer at all, from any condition on this pair, ends the run. The counter is
            // consecutive timeouts, and a pattern that has just answered inside its budget is by
            // definition not the pattern that is wedging the engine. Resetting on every success
            // rather than only on a pattern's success costs nothing — only a pattern can raise
            // the exception that increments it — and keeps this the one line that has to be got
            // right.
            state.PatternTimeouts = 0;
            return verdict;
        }
        catch (RegexMatchTimeoutException)
        {
            // Not a fault, a skip: the pattern was cut off at 50 ms, so nobody found out whether
            // it matched. This is the catch the evaluator no longer has, and the reason it no
            // longer has it — up there the timeout could only have become Skipped, which reads
            // as "the field was missing"; down here it is a countable event on a named pair.
            // The caller's own accounting puts the return value in the skipped bucket.
            if (++state.PatternTimeouts >= _options.PatternTimeoutsBeforeDisable)
                Fault(rule, $"a pattern timed out {state.PatternTimeouts} times in a row " +
                            $"on '{state.Topic}'");

            return Verdict.Skipped;
        }
        catch (Exception ex)
        {
            // Deliberately every exception. Narrowing this to the ones thought of today is how
            // the eleventh kind reaches the pump and StopHost, and the whole point of the field
            // above is that no exception from a rule's own evaluation may leave this method.
            Fault(rule, $"{ex.GetType().Name}: {ex.Message}");
            return Verdict.Skipped;
        }
    }

    /// <summary>
    /// Takes the new rule set and reconciles the live state against it. Returns every alert the
    /// save ended, because nothing else will: SetRules is not on the message path, no tick
    /// follows it, and the webhook and MQTT dispatchers learn that an alarm is over only from
    /// this list. See the spec's "Kaydetme motoru da uzlaştırır".
    /// </summary>
    public EngineOutcome SetRules(IReadOnlyList<AlertRule> rules, DateTimeOffset now)
    {
        // The incoming set, indexed twice, because two separate questions are asked of it below:
        // what each rule now hashes to, and which rules are actually live. Enabled is not in the
        // hash — a rule switched off and back on with nothing else touched is the same rule that
        // was asleep — so the two cannot be one lookup.
        var hashes = new Dictionary<string, string>(StringComparer.Ordinal);
        var live = new Dictionary<string, AlertRule>(StringComparer.Ordinal);

        foreach (var rule in rules)
        {
            hashes[rule.Id] = ConfigHash.Of(rule);
            if (rule.Enabled) live[rule.Id] = rule;
        }

        var resolved = new List<Alert>();

        // Walked over the pairs rather than over the rules, because the commonest reason to drop
        // one is that its rule is not in the new list at all — there would be no rule left to
        // walk from. ToArray so the dictionary can be written to inside the loop.
        foreach (var key in _pairs.Keys.ToArray())
        {
            var reason = WhyDropped(key.RuleId, hashes, live);
            if (reason is null) continue;

            var state = _pairs[key];
            if (state.Active is { } active)
            {
                // The resolved body goes out. This is the entire reason the first outcome
                // exists: Clear runs only on arrival and only while an alert is active, so a
                // pair that will never receive another message would otherwise leave the
                // endpoint holding an alarm that never ends.
                //
                // Through the same two doors as every other resolution in this engine, and not
                // through a shortcut of its own. Close puts it in the history and gives the
                // system ceiling back the slot the alert was holding — a save that dropped a
                // ringing pair without that would leak a slot per save until the ceiling refused
                // alerts nobody was looking at. Announce is the only place that decides whether
                // the user is told, so a muted pair stays muted through a save as well.
                var ended = active with { ResolvedAt = now, ResolvedBy = reason };
                Close(state, ended);
                Announce(state, ended, resolved, now);
            }

            _pairs.Remove(key);
        }

        // What survived keeps all of it: the window, LastSeen, TrueSince, the live alert and its
        // cooldown. Only the two fields that say how an alert reads are refreshed, and they are
        // refreshed on the live alert too — a rule renamed while it is ringing should ring under
        // its new name, not under the one it happened to be saved with.
        foreach (var (key, state) in _pairs)
        {
            var rule = live[key.RuleId];

            // The reset the fault-containment task put beside _faults.Clear(), now that there is
            // a narrower set to apply it to. Same line, same reason — a save is a fresh start
            // for the run of timeouts as well as for the fault — and still exactly one copy: the
            // pairs left in _pairs at this point are the pairs the save decided to keep.
            state.PatternTimeouts = 0;

            if (state.Active is { } active)
                state.Active = active with { RuleName = rule.Name, Severity = rule.Severity };
        }

        // The list is the file's own order, because the panel's diagnostics have to line up with
        // the editor's list. The dictionary is the same set indexed for the message path.
        _rules = rules;
        _byId.Clear();
        foreach (var (id, rule) in live) _byId[id] = rule;

        // Before _hashes is overwritten: the diagnostics reconciliation asks what each rule
        // looked like last time, and this is the last moment that answer exists.
        ReconcileDiagnostics(rules);

        _hashes.Clear();
        foreach (var (id, hash) in hashes) _hashes[id] = hash;

        // A save is the user's whole statement of what the rule set now is, so every rule gets a
        // clean slate. A fault kept across a save leaves the rule dead until a restart — and the
        // panel's fault row exists to send the user to the editor, which would then be the one
        // thing that could not fix it.
        _faults.Clear();

        // The pair a silence rule could never open for itself: a filter with no wildcard is the
        // topic's own name, so 'this device has never spoken' is checkable without a message.
        Arm(rules, now);

        // Compiled once per rule set and never per message. Disabled rules are compiled too, so
        // that switching one on costs nothing on the message path.
        _evaluator = new ConditionEvaluator(CompiledPatterns.For(rules));

        return resolved.Count == 0 ? EngineOutcome.Empty : new EngineOutcome([], resolved);
    }

    /// <summary>
    /// The three outcomes, in the order the spec names them, and null for the pair that is left
    /// alone. Order matters where they overlap: a rule that is both absent from the list and was
    /// disabled last time can only be reported once, and "rule removed" is the truer sentence —
    /// the user's last act on it was to delete it.
    /// </summary>
    private string? WhyDropped(
        string ruleId,
        Dictionary<string, string> hashes,
        Dictionary<string, AlertRule> live)
    {
        if (!hashes.TryGetValue(ruleId, out var hash)) return "rule removed";
        if (!live.ContainsKey(ruleId)) return "rule disabled";

        // A pair whose rule the engine holds no hash for cannot be shown to be the same rule,
        // and "cannot be shown" has to read as changed: state restored from alert-state.json
        // arrives that way, and keeping it on a guess is precisely the mistake this hash was
        // written to stop.
        return _hashes.TryGetValue(ruleId, out var previous) && previous == hash
            ? null
            : "rule changed";
    }

    // ── The handover across a restart ────────────────────────────────────────────────────────
    //
    // A process that dies with an alarm ringing never sends the resolved body: Clear runs on
    // arrival and only while an alert is active, so the pair that would have cleared it is gone
    // with the process. The endpoint is left holding an alarm that never ends. These two methods
    // are the whole of the fix — one writes the promise down, the other honours or closes it.

    /// <summary>
    /// The three things a restart must not lose, and the fingerprints they were held under.
    /// </summary>
    // History is deliberately not here. It is a record, and records belong at the endpoint the
    // webhook posts to; this is a session's tail. An active alert is the opposite — not a record
    // but an open promise — and that is the whole basis on which one is written and the other is
    // not. Spec: "Alarm geçmişi bu dosyada değil."
    //
    // Sorted before it goes out, so that an engine whose state has not moved writes a file
    // identical to the last one. This is written once a second over a mounted volume; a document
    // whose lines reshuffle with a dictionary's internals would look like a change every time to
    // anything watching the file, and would make a diff useless to the person reading it.
    public AlertState Capture()
    {
        var active = new List<Alert>();
        var muted = new List<MutedPair>();
        var cooldowns = new List<CooldownEntry>();
        var named = new HashSet<string>(StringComparer.Ordinal);

        foreach (var state in _pairs.Values)
        {
            if (state.Active is { } alert)
            {
                active.Add(alert);
                named.Add(state.RuleId);
            }

            if (state.MutedUntil is { } until)
            {
                muted.Add(new MutedPair(state.RuleId, state.Topic, until));
                named.Add(state.RuleId);
            }

            // Captured whether or not it has run out. A cooldown that lapses while the process is
            // down is dropped on the way back in, where 'now' is known; the alternative is a
            // clock in here, and there is not one on purpose.
            if (state.CooldownUntil is { } cooling)
            {
                cooldowns.Add(new CooldownEntry(state.RuleId, state.Topic, cooling));
                named.Add(state.RuleId);
            }
        }

        active.Sort(static (a, b) => Pair(a.RuleId, a.Topic, b.RuleId, b.Topic));
        muted.Sort(static (a, b) => Pair(a.RuleId, a.Topic, b.RuleId, b.Topic));
        cooldowns.Sort(static (a, b) => Pair(a.RuleId, a.Topic, b.RuleId, b.Topic));

        // Walked over the rule list rather than over the set of names, because _rules is the
        // file's own order and a HashSet has none. Only the rules something above actually
        // mentions are fingerprinted: the file is a handover for what is open, not a copy of the
        // rule set, which is in alert-rules.json next to it.
        var fingerprints = new List<RuleFingerprint>();
        foreach (var rule in _rules)
            if (named.Contains(rule.Id) && _hashes.TryGetValue(rule.Id, out var hash))
                fingerprints.Add(new RuleFingerprint(rule.Id, hash));

        return new AlertState(active, muted, cooldowns, fingerprints);
    }

    private static int Pair(string ruleA, string topicA, string ruleB, string topicB)
    {
        var byRule = string.CompareOrdinal(ruleA, ruleB);
        return byRule != 0 ? byRule : string.CompareOrdinal(topicA, topicB);
    }

    /// <summary>
    /// Puts a captured state back, reconciled against the rules this engine is already holding.
    /// </summary>
    // Called after SetRules and never before it, because every question this method asks is about
    // the rule set: is the rule still there, is it still switched on, does it still mean what it
    // meant when the state was written. An engine that has not been given its rules answers
    // "removed" to all three, which is the safe answer and not an accident.
    //
    // The resolutions come back in the outcome for the same reason SetRules' do: the webhook and
    // MQTT dispatchers learn that an alarm is over from that list and from nowhere else, and an
    // alarm dropped here is one nothing else will ever close. Spec: "Açılışta mevcut kural
    // listesine karşı uzlaştırılır."
    public EngineOutcome Restore(AlertState state, DateTimeOffset now)
    {
        var fingerprints = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var fingerprint in state.Fingerprints ?? []) fingerprints[fingerprint.RuleId] = fingerprint.Hash;

        // Mutes and cooldowns first, so that a pair is already carrying them by the time its
        // alert arrives and the alert's own label can be taken from the pair rather than from the
        // file. One authority for 'is this silenced', which is what Mute() is careful about too.
        foreach (var pair in state.Muted)
        {
            // A mute that ran out while the process was down is over. Restoring it would silence
            // a pair the user silenced until nine o'clock at half past ten.
            if (now >= pair.Until) continue;
            if (Reopen(pair.RuleId, pair.Topic, fingerprints) is not { } muted) continue;

            // Clamped for the reason MaxMuteMinutes gives: this record has been through a text
            // editor as easily as through a panel, and a day is the point past which muting is
            // disabling the rule without saying so.
            var ceiling = now.AddMinutes(MaxMuteMinutes);
            muted.MutedUntil = pair.Until > ceiling ? ceiling : pair.Until;
        }

        foreach (var entry in state.Cooldowns)
        {
            if (now >= entry.Until) continue;
            if (Reopen(entry.RuleId, entry.Topic, fingerprints) is { } cooling)
                cooling.CooldownUntil = entry.Until;
        }

        List<Alert>? resolved = null;

        foreach (var alert in state.Active)
        {
            if (WhyStale(alert.RuleId, fingerprints) is { } reason)
            {
                // Through Remember rather than Close, and that is not an oversight: Close gives
                // back a slot under the active ceiling, and this alert never took one — it comes
                // from a file, and the engine it belonged to is gone.
                var ended = alert with { ResolvedAt = now, ResolvedBy = reason };
                Remember(ended);

                // Announce's decision, made without a pair to ask. The alert's own MutedUntil is
                // the only record left of the silence somebody asked for, and a mute that has not
                // yet run out still means what it meant: stop telling me about this.
                if (ended.MutedUntil is not { } until || now >= until) (resolved ??= []).Add(ended);
                continue;
            }

            var rule = _byId[alert.RuleId];

            // Through Track, so a restored pair meets every ceiling a live one does. A state file
            // written by a build with a larger MaxPairs must not be able to talk this engine past
            // its own limits.
            var pair = Track(rule, alert.Topic);
            if (pair is null) continue;

            // A file naming the same pair twice — hand-edited, or written by something else —
            // gets one alert. The first wins; the second would need a second slot for a pair that
            // by definition has one alarm.
            if (pair.Active is not null) continue;

            // The alert comes back as it was — same id, same FiredAt, same Count, so the endpoint
            // sees the alarm it was already told about rather than a new one — wearing the rule's
            // current wording. Name, severity and actions are outside ConfigHash precisely
            // because editing them does not end an alarm, so the alarm has to pick them up.
            var restored = alert with
            {
                RuleName = rule.Name,
                Severity = rule.Severity,
                Actions = rule.Actions,
                MutedUntil = pair.MutedUntil,
            };

            if (TryOpen(pair, rule, restored, now) is null) continue;

            // TryOpen stamps the tally with 'now', which is right for an alarm that has just gone
            // off and wrong for one that went off before the restart. The panel's "last fired"
            // column is a statement about the plant, not about this process's uptime.
            TallyOf(rule.Id).LastFiredAt = alert.FiredAt;

            // The restart is a gap nobody watched, so the pair starts listening from now — the
            // same decision Resume makes for an outage and Arm makes for a rule that has just
            // been saved. Carrying the file's own LastSeenAt across would let a silence rule ring
            // the instant the console came back for a device that had been quiet for a week
            // — about a week nobody was watching.
            pair.LastSeen ??= now;
        }

        return resolved is null ? EngineOutcome.Empty : new EngineOutcome([], resolved);
    }

    /// <summary>The pair a restored mute or cooldown belongs to, or null when its rule has moved on.</summary>
    private RuleState? Reopen(string ruleId, string topic, Dictionary<string, string> fingerprints) =>
        WhyStale(ruleId, fingerprints) is null ? Track(_byId[ruleId], topic) : null;

    /// <summary>
    /// Whether a restored record still belongs to the rule it was written under, and if not, what
    /// to say about it.
    /// </summary>
    // WhyDropped's three answers, in WhyDropped's order, asked the other way round: there the
    // engine holds the old fingerprints and the save brings the new ones, here the engine holds
    // the new ones and the file brings the old. The strings are the same strings on purpose —
    // "rule changed" means one thing to the person reading the console, whether their rule
    // changed while the app was running or while it was off.
    private string? WhyStale(string ruleId, Dictionary<string, string> fingerprints)
    {
        if (!_hashes.TryGetValue(ruleId, out var hash)) return "rule removed";
        if (!_byId.ContainsKey(ruleId)) return "rule disabled";

        // A record with no fingerprint cannot be shown to be the same rule, and "cannot be shown"
        // reads as changed — the position WhyDropped already takes for exactly this case. Keeping
        // an alarm on a guess is the mistake the hash was written to stop.
        return fingerprints.TryGetValue(ruleId, out var was) && was == hash ? null : "rule changed";
    }

    // The panel's vocabulary and the webhook's, in one place. Lower case and no articles, so that
    // they read inside the sentences above rather than beside them.
    private static string Word(FitName name) => name switch
    {
        FitName.Normal => "normal",
        FitName.Uniform => "uniform",
        _ => "exponential",
    };

    // 'a quantity' rather than 'continuous', because the reader of an alarm is not reading a
    // taxonomy — they are being told that the thing which used to have a mean now has two states.
    private static string Word(ShapeId id) => id switch
    {
        ShapeId.Continuous => "a quantity",
        ShapeId.State => "a state machine",
        ShapeId.Pulse => "a pulse train",
        _ => "unreadable",
    };

    private static string Word(PulseMetric metric) => metric switch
    {
        PulseMetric.Count => "pulses",
        PulseMetric.Duty => "duty",
        PulseMetric.Period => "period (ms)",
        _ => "width (ms)",
    };

    /// <summary>How many warming pairs the panel is shown at once.</summary>
    // A hundred is more rows than anybody reads and far fewer than a '#' rule produces on a fresh
    // broker. The alternative — every one of them — would put a thousand rows into a frame that is
    // sent once a second, to say something that stops being true after twenty readings.
    public const int MaxWarmingShown = 100;
}
