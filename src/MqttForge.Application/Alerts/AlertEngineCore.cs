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
        // First, before anything else looks at it. Our own alarm lands back in our own
        // subscription, and a rule covering that topic would have the alarm raise an alarm for
        // ever. The rule editor refuses such a filter as well; that is the courtesy, this is the
        // guard, and one of the two has to hold whatever the user typed.
        if (message.Topic.StartsWith(_options.TopicPrefix, StringComparison.Ordinal))
            return EngineOutcome.Empty;

        // A replayed retained value is the broker repeating itself, not the plant speaking. It
        // is not judged, not written to a ring, and does not count as having seen the topic —
        // otherwise every subscribe and every reconnect starts an alarm storm out of old values,
        // and a device that died an hour ago has its silence clock reset on the way past.
        if (message.Replay) return EngineOutcome.Empty;

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

            // The ring is filled by arrival, not by whichever condition happens to want it, so a
            // condition never has to ask for history that was not kept.
            if (state.Window is not null && number is { } reading)
                state.Window.Add(new Reading(message.ReceivedAt.UtcTicks, reading));

            var context = new EvalContext(
                message.Topic, found ? text : null, number, now, state.LastSeen, state.Window);

            var verdict = _evaluator.Evaluate(rule.Condition, in context);

            // Missing data is not judged and is not counted false. A rule saying '< 10' would
            // otherwise fire on every message that does not carry the field at all, and a device
            // saying 'warming up' is not a device below ten. Skips are counted, and the panel
            // shows them: a rule passing over everything it sees looks exactly like a rule with
            // nothing to report.
            if (verdict == Verdict.Skipped)
            {
                state.Skipped++;
                continue;
            }

            state.Evaluated++;
            state.LastEvaluated = now;

            if (verdict == Verdict.False)
            {
                // Recorded, not acted on. Resolution happens on the tick and only there: a late
                // firing is a missed threshold, while a late resolution is only late — and
                // taking the decision to the tick is what holds a flapping pair to one state
                // change a second.
                state.TrueSince = null;
                continue;
            }

            state.TrueSince ??= now;

            if (state.Active is { } active)
            {
                // The alarm belongs to the pair, so a second true reading is the same alarm
                // seen again. The value stays the one that fired it: an alert that quietly
                // rewrites 95 to 90.1 loses the reading that made someone get up.
                state.Active = active with { LastSeenAt = now, Count = active.Count + 1 };
                continue;
            }

            var alarm = new Alert(
                Id: NextId(now),
                RuleId: rule.Id,
                RuleName: rule.Name,
                Topic: message.Topic,
                Severity: rule.Severity,
                FiredAt: now,
                LastSeenAt: now,
                ResolvedAt: null,
                ResolvedBy: null,
                MutedUntil: state.MutedUntil,
                Count: 1,
                // The sentence someone reads at three in the morning, and the slice of payload
                // under it, are both task 8's. Not because they are an afterthought but because
                // task 8 is the one that rewrites this raise into Raise(…) and needs a Describe
                // that answers with a number (an arrival) and without one (a tick); a narrower
                // one written here would be a member two tasks own, and the two would drift.
                Reason: string.Empty,
                Value: number,
                Sample: null,
                Actions: rule.Actions);

            state.Active = alarm;
            (raised ??= []).Add(alarm);
        }

        return Outcome(raised, null);
    }

    // Every resolution in the engine happens here. 'connected' is not read on this path: a
    // resolution is a decision arrival already made, and it should land whether or not the link
    // came back. It is the silence clock and the maturing 'for' that stop while the link is
    // down, because a broker that dropped is one event and not a hundred sensors going quiet.
    public EngineOutcome OnTick(DateTimeOffset now, bool connected)
    {
        List<Alert>? resolved = null;

        foreach (var state in _pairs.Values)
        {
            if (state.Active is null) continue;

            // A rule that is gone or switched off is dealt with when the rule set changes, not
            // here; this only skips it so a stale pair cannot be judged against a rule the
            // engine no longer has.
            if (!_byId.TryGetValue(state.RuleId, out var rule) || !rule.Enabled) continue;

            if (state.TrueSince is null)
                (resolved ??= []).Add(Close(state, "clear", now));
        }

        return Outcome(null, resolved);
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
}
