using System.Text.RegularExpressions;
using MqttForge.Application.Alerts;
using MqttForge.Application.Alerts.Conditions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Alerts;

/// <summary>
/// What the engine does when a rule misbehaves, and why it is not allowed to do the obvious
/// thing and let the exception out.
///
/// The pump that carries messages into this engine is a copy of SignalRMessageNotifier, and that
/// copy stops at exactly one line. SignalRMessageNotifier.cs:71-93 wraps its whole loop in a
/// single catch for OperationCanceledException and nothing else, and DependencyInjection.cs:20
/// registers it with AddHostedService. Nothing in this repository sets
/// BackgroundServiceExceptionBehavior, so the host default stands, and that default is StopHost:
/// one exception out of that ExecuteAsync and the entire application goes down. In the notifier
/// that is close to harmless, because everything inside its loop is ours — a channel read, a hub
/// send, a delay. Here it would not be. The body of this loop runs a regular expression the user
/// typed into a form, walks a JSON document a stranger's broker sent, and ends in a publish that
/// throws NotConnectedException the moment the link drops. A monitoring tool that shuts itself
/// down because somebody saved a bad rule is worse than one that never had rules.
///
/// So the fault is caught, named, and set aside — and the tests below are what says so.
/// </summary>
public class AlertEngineFaultContainmentTests
{
    private static readonly DateTimeOffset T0 = new(2026, 8, 30, 9, 0, 0, TimeSpan.Zero);

    // The hostile pattern and its payload are declared once, in final task 5's condition tests,
    // and read from there. Two copies would be two chances to write a pattern that
    // NonBacktracking quietly answers in linear time — and every timeout test below would then
    // pass while testing nothing at all. The reasoning for this exact shape is on the constant
    // itself; the premise is asserted again here, in
    // The_catastrophic_pattern_really_does_fall_back_off_NonBacktracking.
    private const string Catastrophic = HostilePatterns.Catastrophic;
    private static readonly string Hostile = HostilePatterns.Payload;

    private static AlertEngineCore Engine() => new(new AlertEngineOptions());

    private static AlertRule Rule(string id, AlertCondition condition, string filter = "plant/#") =>
        new(id, $"Rule {id}", Enabled: true, filter, Field: null, condition, Clear: null,
            For: null, Cooldown: null, AlertSeverity.Warn, [new ScreenAction()]);

    private static AlertRule Ticking(string id) =>
        Rule(id, new PatternCondition(Catastrophic, Negate: false));

    private static MqttMessage Message(string topic, string payload, DateTimeOffset at) =>
        new(topic, payload, "text", Qos: 0, Retain: false, at);

    private static RuleDiagnostic DiagnosticFor(AlertEngineCore engine, string ruleId) =>
        engine.Snapshot().Rules.Single(rule => rule.RuleId == ruleId);

    /// One second apart, so that nothing here is quietly measuring the per-second quota instead
    /// of the run of timeouts it means to measure.
    private static void TimeOutTimes(AlertEngineCore engine, int times, DateTimeOffset from)
    {
        for (var index = 0; index < times; index++)
        {
            var at = from.AddSeconds(index);
            engine.OnMessage(Message("plant/boiler/state", Hostile, at), at);
        }
    }

    /// <summary>
    /// A condition type the evaluator has never been taught. It stands in for the real ways this
    /// happens — a condition added to the union and not to the switch, a statistical condition
    /// reaching the engine from a rule file written by a newer version — and it is the only
    /// honest way to make evaluation throw on demand without weakening the code under test.
    /// </summary>
    private sealed record ExplodingCondition : AlertCondition;

    [Fact]
    public void OnMessage_does_not_throw_when_a_condition_throws()
    {
        var engine = Engine();
        engine.SetRules([Rule("boom", new ExplodingCondition())], T0);

        var outcome = engine.OnMessage(Message("plant/boiler/temp", "42", T0), T0);

        Assert.Empty(outcome.Raised);
        Assert.Empty(outcome.Resolved);
    }

    [Fact]
    public void OnMessage_marks_the_rule_that_threw_as_faulted_and_says_what_threw()
    {
        var engine = Engine();
        engine.SetRules([Rule("boom", new ExplodingCondition())], T0);

        engine.OnMessage(Message("plant/boiler/temp", "42", T0), T0);

        var diagnostic = DiagnosticFor(engine, "boom");
        Assert.True(diagnostic.Faulted);
        Assert.Contains(nameof(NotSupportedException), diagnostic.FaultReason!);
    }

    // The whole point of containing a fault rather than letting it out: the message the broken
    // rule choked on is the same message every other rule is waiting for. The broken rule is
    // listed first on purpose — that is the order in which a loop that gives up would be wrong.
    [Fact]
    public void OnMessage_keeps_every_other_rule_evaluating_on_the_same_message()
    {
        var engine = Engine();
        engine.SetRules(
        [
            Rule("boom", new ExplodingCondition()),
            Rule("hot", new ThresholdCondition(ThresholdOp.Gt, 90)),
        ], T0);

        var outcome = engine.OnMessage(Message("plant/boiler/temp", "94.2", T0), T0);

        var raised = Assert.Single(outcome.Raised);
        Assert.Equal("hot", raised.RuleId);
        Assert.True(DiagnosticFor(engine, "boom").Faulted);
        Assert.False(DiagnosticFor(engine, "hot").Faulted);
    }

    // Faulted means set aside, not merely reported. A condition that threw on one payload will
    // throw on the next thousand, and an engine that keeps calling it pays for a stack trace per
    // message for as long as the process lives.
    //
    // The arrival that threw counts as Skipped, because that is what happened to it: it could
    // not be judged. The arrivals after it count as neither. Inflating Skipped for a rule that
    // is not being looked at at all would make the panel's "no message could be read" line say
    // something false about the messages, when the true sentence is already on the fault row.
    [Fact]
    public void A_faulted_rule_is_not_evaluated_again()
    {
        var engine = Engine();
        engine.SetRules([Rule("boom", new ExplodingCondition())], T0);

        engine.OnMessage(Message("plant/boiler/temp", "42", T0), T0);
        engine.OnMessage(Message("plant/boiler/temp", "43", T0.AddSeconds(1)), T0.AddSeconds(1));

        var diagnostic = DiagnosticFor(engine, "boom");
        Assert.Equal(0L, diagnostic.Evaluated);
        Assert.Equal(1L, diagnostic.Skipped);
    }

    // The tick path forgetting the check the message path has is the realistic way this comes
    // back, because OnTick walks the same pairs for silence and for `For` maturing.
    [Fact]
    public void OnTick_does_not_throw_after_a_rule_has_faulted()
    {
        var engine = Engine();
        engine.SetRules([Rule("boom", new ExplodingCondition())], T0);
        engine.OnMessage(Message("plant/boiler/temp", "42", T0), T0);

        var outcome = engine.OnTick(T0.AddSeconds(1), connected: true);

        Assert.Empty(outcome.Raised);
        Assert.Empty(outcome.Resolved);
    }

    // A save is the user's whole statement of what the rule set now is, so every rule starts
    // again from clean. A fault kept across a save would leave the rule dead until someone
    // restarted the process — and the panel's fault row exists precisely to send the user to the
    // editor, which would then be the one thing that could not fix it.
    [Fact]
    public void SetRules_clears_the_fault()
    {
        var engine = Engine();
        var broken = Rule("boom", new ExplodingCondition());
        engine.SetRules([broken], T0);
        engine.OnMessage(Message("plant/boiler/temp", "42", T0), T0);

        engine.SetRules([broken], T0.AddSeconds(5));

        var diagnostic = DiagnosticFor(engine, "boom");
        Assert.False(diagnostic.Faulted);
        Assert.Null(diagnostic.FaultReason);
    }

    // Clearing costs one more throw when the rule is still broken, and buys a rule that works
    // again the moment it is repaired — without a restart.
    [Fact]
    public void A_rule_repaired_by_SetRules_evaluates_again()
    {
        var engine = Engine();
        engine.SetRules([Rule("boom", new ExplodingCondition())], T0);
        engine.OnMessage(Message("plant/boiler/temp", "94.2", T0), T0);

        engine.SetRules([Rule("boom", new ThresholdCondition(ThresholdOp.Gt, 90))], T0.AddSeconds(5));
        var outcome = engine.OnMessage(
            Message("plant/boiler/temp", "94.2", T0.AddSeconds(6)), T0.AddSeconds(6));

        Assert.Single(outcome.Raised);
        Assert.False(DiagnosticFor(engine, "boom").Faulted);
    }

    // The premise every timeout test below rests on, said out loud rather than assumed. If a
    // future .NET taught NonBacktracking to handle lookbehind, this pattern would answer in
    // linear time and every one of those tests would pass while testing nothing at all.
    [Fact]
    public void The_catastrophic_pattern_really_does_fall_back_off_NonBacktracking()
    {
        var compiled = CompiledPatterns.Compile(Catastrophic);

        Assert.False(compiled.Options.HasFlag(RegexOptions.NonBacktracking));
        Assert.Equal(TimeSpan.FromMilliseconds(50), compiled.MatchTimeout);
        Assert.Throws<RegexMatchTimeoutException>(() => compiled.IsMatch(Hostile));
    }

    // A timeout is not a false. The pattern did not fail to match — nobody found out whether it
    // matched, which is what Skipped means and why Verdict has three values. Calling it false
    // would make a `negate: true` rule fire on a message it never read.
    //
    // And one timeout is not a fault either: a single slow message on a busy broker is a bad
    // afternoon, not a broken rule.
    [Fact]
    public void A_pattern_that_times_out_skips_the_message_rather_than_calling_it_false()
    {
        var engine = Engine();
        engine.SetRules([Ticking("slow")], T0);

        var outcome = engine.OnMessage(Message("plant/boiler/state", Hostile, T0), T0);

        Assert.Empty(outcome.Raised);
        var diagnostic = DiagnosticFor(engine, "slow");
        Assert.Equal(0L, diagnostic.Evaluated);
        Assert.Equal(1L, diagnostic.Skipped);
        Assert.False(diagnostic.Faulted);
    }

    [Fact]
    public void Nine_timeouts_in_a_row_do_not_disable_the_rule()
    {
        var engine = Engine();
        engine.SetRules([Ticking("slow")], T0);

        TimeOutTimes(engine, 9, from: T0);

        var diagnostic = DiagnosticFor(engine, "slow");
        Assert.False(diagnostic.Faulted);
        Assert.Equal(9L, diagnostic.Skipped);
    }

    // Ten in a row is no longer an afternoon, it is a pattern that cannot answer, and the engine
    // is spending fifty milliseconds of its single thread on every message to find that out
    // again. An engine that silently slows down is worse than one that stops and says why.
    [Fact]
    public void Ten_timeouts_in_a_row_disable_the_rule_and_say_why()
    {
        var engine = Engine();
        engine.SetRules([Ticking("slow")], T0);

        TimeOutTimes(engine, 10, from: T0);

        var diagnostic = DiagnosticFor(engine, "slow");
        Assert.True(diagnostic.Faulted);
        Assert.Contains("timed out", diagnostic.FaultReason!);
        Assert.Contains("plant/boiler/state", diagnostic.FaultReason!);
    }

    // Disabling it has to actually stop the spend, which is the only reason to disable it.
    [Fact]
    public void A_disabled_rule_stops_costing_the_engine_its_fifty_milliseconds()
    {
        var engine = Engine();
        engine.SetRules([Ticking("slow")], T0);
        TimeOutTimes(engine, 10, from: T0);

        engine.OnMessage(
            Message("plant/boiler/state", Hostile, T0.AddSeconds(20)), T0.AddSeconds(20));

        Assert.Equal(10L, DiagnosticFor(engine, "slow").Skipped);
    }

    // A run, not a total. A pattern that is fine on ordinary payloads and hopeless on one
    // occasional monster is a rule worth keeping; a total would eventually kill it anyway, at
    // some hour of some day that had nothing to do with anything.
    [Fact]
    public void A_match_in_time_resets_the_run_of_timeouts()
    {
        var engine = Engine();
        engine.SetRules([Ticking("slow")], T0);

        TimeOutTimes(engine, 9, from: T0);
        // 'z' fails against the anchored '^(a+)' on the very first character: nothing to
        // backtrack through, so this one answers immediately and honestly.
        engine.OnMessage(
            Message("plant/boiler/state", "zzz", T0.AddSeconds(9)), T0.AddSeconds(9));
        TimeOutTimes(engine, 9, from: T0.AddSeconds(10));

        var diagnostic = DiagnosticFor(engine, "slow");
        Assert.False(diagnostic.Faulted);
        Assert.Equal(18L, diagnostic.Skipped);
        Assert.Equal(1L, diagnostic.Evaluated);
    }

    [Fact]
    public void The_run_after_a_reset_still_disables_the_rule_on_its_tenth()
    {
        var engine = Engine();
        engine.SetRules([Ticking("slow")], T0);

        TimeOutTimes(engine, 9, from: T0);
        engine.OnMessage(
            Message("plant/boiler/state", "zzz", T0.AddSeconds(9)), T0.AddSeconds(9));
        TimeOutTimes(engine, 10, from: T0.AddSeconds(10));

        Assert.True(DiagnosticFor(engine, "slow").Faulted);
    }

    // "The same pair", the spec says, and it means it: the run lives on RuleState, which is one
    // per (rule, topic). A wildcard rule alternating between two topics never reaches ten in a
    // row on either, and stays alive. That is the conservative reading and the right one — a
    // rule-wide run would kill a rule that answers fine on ninety-nine topics because one
    // device sends 4 kB of padding.
    [Fact]
    public void The_run_is_kept_per_pair_not_per_rule()
    {
        var engine = Engine();
        engine.SetRules([Ticking("slow")], T0);

        for (var index = 0; index < 9; index++)
        {
            var at = T0.AddSeconds(index);
            engine.OnMessage(Message("plant/a/state", Hostile, at), at);
            engine.OnMessage(Message("plant/b/state", Hostile, at), at);
        }

        var diagnostic = DiagnosticFor(engine, "slow");
        Assert.False(diagnostic.Faulted);
        Assert.Equal(18L, diagnostic.Skipped);
        Assert.Equal(2, diagnostic.Topics);
    }

    // Same reasoning as clearing the fault: a save is a fresh start for the rule, including for
    // the run of timeouts on the pairs the save decided to keep. At this task SetRules keeps
    // every pair it has, so the reset is the whole of what is being asserted; final task 15
    // narrows the set to the pairs that survive reconciliation and this test goes on holding,
    // because a renamed rule is one of the pairs that survives.
    [Fact]
    public void SetRules_resets_the_run_of_timeouts_on_a_pair_it_keeps()
    {
        var engine = Engine();
        var slow = Ticking("slow");
        engine.SetRules([slow], T0);
        TimeOutTimes(engine, 9, from: T0);

        engine.SetRules([slow with { Name = "Still slow" }], T0.AddSeconds(9));
        TimeOutTimes(engine, 9, from: T0.AddSeconds(10));

        Assert.False(DiagnosticFor(engine, "slow").Faulted);
    }
}
