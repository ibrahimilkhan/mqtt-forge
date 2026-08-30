using MqttForge.Application.Alerts;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Alerts;

/// <summary>
/// What survives a restart, and what is deliberately not allowed to.
///
/// A process that dies with an alarm ringing never sends the resolved body — Clear runs on
/// arrival and only while an alert is active, and the pair that would have cleared it died with
/// the process — so the endpoint holds an open alarm for ever. The trigger is not a user action:
/// `restart: unless-stopped` restarts a container as a matter of course.
///
/// The reconciliation is the other half. The rules file can be edited by hand while the process
/// is down, so an alarm coming back has to be shown to belong to a rule that is still there, is
/// still switched on, and still means what it meant — or it resolves instead, with the same three
/// sentences a save uses.
/// </summary>
public class AlertStateHandoverTests
{
    private static readonly DateTimeOffset T0 = new(2026, 8, 30, 9, 0, 0, TimeSpan.Zero);
    private static readonly DateTimeOffset T1 = T0.AddMinutes(5);

    private static AlertEngineCore Engine() => new(new AlertEngineOptions());

    private static AlertRule Hot(
        string id = "hot",
        string filter = "plant/+/temp",
        double over = 90,
        bool enabled = true,
        string name = "Boiler temperature",
        AlertSeverity severity = AlertSeverity.Warn,
        int? cooldown = null) =>
        new(id, name, enabled, filter, Field: null, new ThresholdCondition(ThresholdOp.Gt, over),
            Clear: null, For: null, cooldown, severity, [new ScreenAction()]);

    private static MqttMessage Message(string payload, DateTimeOffset at,
                                       string topic = "plant/boiler/temp") =>
        new(topic, payload, "text", Qos: 0, Retain: false, at);

    /// An engine with one alarm ringing, and the alarm itself.
    private static (AlertEngineCore Engine, Alert Ringing) Ringing(AlertRule rule)
    {
        var engine = Engine();
        engine.SetRules([rule], T0);
        var outcome = engine.OnMessage(Message("94.2", T0), T0);
        return (engine, Assert.Single(outcome.Raised));
    }

    /// A second engine that has been given a rule set and nothing else — a fresh process.
    private static AlertEngineCore Restarted(params AlertRule[] rules)
    {
        var engine = Engine();
        engine.SetRules(rules, T1);
        return engine;
    }

    // ── What is captured ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void Capture_carries_the_alarms_that_are_still_ringing()
    {
        var (engine, ringing) = Ringing(Hot());

        var captured = engine.Capture();

        Assert.Equal(ringing.Id, Assert.Single(captured.Active).Id);
    }

    [Fact]
    public void Capture_carries_a_mute_and_the_moment_it_ends()
    {
        var (engine, _) = Ringing(Hot());
        engine.Mute("hot", "plant/boiler/temp", 30, T0);

        var captured = engine.Capture();

        var muted = Assert.Single(captured.Muted);
        Assert.Equal("hot", muted.RuleId);
        Assert.Equal("plant/boiler/temp", muted.Topic);
        Assert.Equal(T0.AddMinutes(30), muted.Until);
    }

    [Fact]
    public void Capture_carries_a_cooldown_that_has_not_run_out()
    {
        var (engine, _) = Ringing(Hot());

        // Under the threshold, then a tick: the alarm clears and the pair starts cooling.
        engine.OnMessage(Message("21.0", T0.AddSeconds(1)), T0.AddSeconds(1));
        engine.OnTick(T0.AddSeconds(1), connected: true);

        var cooling = Assert.Single(engine.Capture().Cooldowns);
        Assert.Equal("hot", cooling.RuleId);
        Assert.Equal("plant/boiler/temp", cooling.Topic);
        Assert.True(cooling.Until > T0.AddSeconds(1));
    }

    // The line the spec draws, and the reason the file has three lists rather than four. History
    // is a record and records live at the endpoint the webhook posts to; an active alert is an
    // unclosed promise, and closing it is what this file exists for.
    [Fact]
    public void Capture_leaves_the_alert_history_behind()
    {
        var (engine, _) = Ringing(Hot());
        engine.OnMessage(Message("21.0", T0.AddSeconds(1)), T0.AddSeconds(1));
        engine.OnTick(T0.AddSeconds(1), connected: true);

        // The alarm is over, so it is in the history and in nothing else.
        Assert.Single(engine.Snapshot().History);
        var captured = engine.Capture();

        Assert.Empty(captured.Active);
    }

    [Fact]
    public void Capture_fingerprints_only_the_rules_it_names()
    {
        var (engine, _) = Ringing(Hot());
        engine.SetRules([Hot(), Hot(id: "cold", filter: "lab/+/temp")], T0);
        engine.OnMessage(Message("94.2", T0), T0);

        var fingerprints = engine.Capture().Fingerprints;

        Assert.NotNull(fingerprints);
        Assert.Equal("hot", Assert.Single(fingerprints).RuleId);
    }

    // ── What comes back ──────────────────────────────────────────────────────────────────────

    [Fact]
    public void Restore_brings_back_the_alarm_that_was_ringing()
    {
        var (engine, ringing) = Ringing(Hot());
        var restarted = Restarted(Hot());

        var outcome = restarted.Restore(engine.Capture(), T1);

        Assert.Empty(outcome.Resolved);
        var active = Assert.Single(restarted.Snapshot().Active);
        // The same alert and not a new one: same id, same moment it fired, same count. The
        // endpoint was told about this alarm before the restart and must not be told again.
        Assert.Equal(ringing.Id, active.Id);
        Assert.Equal(ringing.FiredAt, active.FiredAt);
        Assert.Equal(ringing.Count, active.Count);
    }

    // A ten-minute cooldown, so that the five minutes the process spends dead do not use it up —
    // a cooldown that lapses in the gap has its own test below.
    [Fact]
    public void Restore_brings_back_a_mute_and_a_cooldown()
    {
        var patient = Hot(cooldown: 600);
        var (engine, _) = Ringing(patient);
        engine.Mute("hot", "plant/boiler/temp", 30, T0);
        engine.OnMessage(Message("21.0", T0.AddSeconds(1)), T0.AddSeconds(1));
        engine.OnTick(T0.AddSeconds(1), connected: true);
        var captured = engine.Capture();

        var restarted = Restarted(patient);
        restarted.Restore(captured, T1);

        var muted = Assert.Single(restarted.Snapshot().Muted);
        Assert.Equal(T0.AddMinutes(30), muted.Until);
        // The cooldown came back too, so the pair that was cooling still cannot ring: a restart
        // must not be a way to get past the flapping defence.
        Assert.Equal(Assert.Single(captured.Cooldowns).Until, Assert.Single(restarted.Capture().Cooldowns).Until);
    }

    [Fact]
    public void An_alarm_whose_rule_was_deleted_resolves_as_rule_removed()
    {
        var (engine, ringing) = Ringing(Hot());
        var restarted = Restarted(Hot(id: "something-else", filter: "lab/+/temp"));

        var outcome = restarted.Restore(engine.Capture(), T1);

        var resolved = Assert.Single(outcome.Resolved);
        Assert.Equal(ringing.Id, resolved.Id);
        Assert.Equal("rule removed", resolved.ResolvedBy);
        Assert.Equal(T1, resolved.ResolvedAt);
        Assert.Empty(restarted.Snapshot().Active);
    }

    // The case the fingerprint exists for: the rules file was edited while the process was down,
    // and an alarm about '> 90' cannot be re-opened as an alarm about '> 95'.
    [Fact]
    public void An_alarm_whose_rule_was_edited_resolves_as_rule_changed()
    {
        var (engine, _) = Ringing(Hot());
        var restarted = Restarted(Hot(over: 95));

        var outcome = restarted.Restore(engine.Capture(), T1);

        Assert.Equal("rule changed", Assert.Single(outcome.Resolved).ResolvedBy);
        Assert.Empty(restarted.Snapshot().Active);
    }

    [Fact]
    public void An_alarm_whose_rule_was_switched_off_resolves_as_rule_disabled()
    {
        var (engine, _) = Ringing(Hot());
        var restarted = Restarted(Hot(enabled: false));

        var outcome = restarted.Restore(engine.Capture(), T1);

        Assert.Equal("rule disabled", Assert.Single(outcome.Resolved).ResolvedBy);
        Assert.Empty(restarted.Snapshot().Active);
    }

    // A resolution that comes out of Restore still goes into the history, because the panel's
    // history is where a reader finds out what happened while they were not looking.
    [Fact]
    public void An_alarm_dropped_on_restore_is_remembered()
    {
        var (engine, ringing) = Ringing(Hot());
        var restarted = Restarted(Hot(over: 95));

        restarted.Restore(engine.Capture(), T1);

        Assert.Equal(ringing.Id, Assert.Single(restarted.Snapshot().History).Id);
    }

    // A state file with no fingerprints at all — hand-written, or from a build that did not keep
    // them. It cannot be shown to be the same rule, so it reads as changed rather than being
    // taken on trust.
    [Fact]
    public void An_alarm_with_no_fingerprint_resolves_as_rule_changed()
    {
        var (engine, _) = Ringing(Hot());
        var handed = engine.Capture();
        var restarted = Restarted(Hot());

        var outcome = restarted.Restore(new AlertState(handed.Active, [], []), T1);

        Assert.Equal("rule changed", Assert.Single(outcome.Resolved).ResolvedBy);
    }

    // Muting gates telling, not watching, and that holds across a restart as well: the alarm is
    // closed and remembered, but the person who asked not to hear about it is not told.
    [Fact]
    public void A_muted_alarm_whose_rule_is_gone_is_remembered_but_not_announced()
    {
        var (engine, _) = Ringing(Hot());
        engine.Mute("hot", "plant/boiler/temp", 30, T0);
        var restarted = Restarted();

        var outcome = restarted.Restore(engine.Capture(), T1);

        Assert.Empty(outcome.Resolved);
        Assert.Single(restarted.Snapshot().History);
    }

    // ── The awkward ones ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void A_mute_that_ran_out_while_the_process_was_down_does_not_come_back()
    {
        var (engine, _) = Ringing(Hot());
        engine.Mute("hot", "plant/boiler/temp", 1, T0);
        var restarted = Restarted(Hot());

        // T1 is five minutes later; the mute was for one.
        restarted.Restore(engine.Capture(), T1);

        Assert.Empty(restarted.Snapshot().Muted);
    }

    [Fact]
    public void A_cooldown_that_ran_out_while_the_process_was_down_does_not_come_back()
    {
        var (engine, _) = Ringing(Hot());
        engine.OnMessage(Message("21.0", T0.AddSeconds(1)), T0.AddSeconds(1));
        engine.OnTick(T0.AddSeconds(1), connected: true);
        var restarted = Restarted(Hot());

        restarted.Restore(engine.Capture(), T1);

        Assert.Empty(restarted.Capture().Cooldowns);
    }

    // The file can be edited by hand, so the clamp Mute() applies has to apply here too: a mute
    // longer than a day is switching the rule off without saying so.
    [Fact]
    public void A_mute_longer_than_a_day_is_clamped_on_the_way_in()
    {
        var (engine, _) = Ringing(Hot());
        var handed = engine.Capture();
        var forged = new AlertState(
            handed.Active,
            [new MutedPair("hot", "plant/boiler/temp", T1.AddDays(30))],
            [],
            handed.Fingerprints);
        var restarted = Restarted(Hot());

        restarted.Restore(forged, T1);

        Assert.Equal(T1.AddMinutes(AlertEngineCore.MaxMuteMinutes), Assert.Single(restarted.Snapshot().Muted).Until);
    }

    // A restored alarm wears the rule's current wording. Name and severity are outside
    // ConfigHash on purpose — renaming an alarm that is ringing does not end it — so the alarm
    // has to pick the new wording up rather than keep the words it was saved with.
    [Fact]
    public void A_restored_alarm_takes_the_rules_current_name_and_severity()
    {
        var (engine, _) = Ringing(Hot());
        var restarted = Restarted(Hot(name: "Boiler is too hot", severity: AlertSeverity.Critical));

        restarted.Restore(engine.Capture(), T1);

        var active = Assert.Single(restarted.Snapshot().Active);
        Assert.Equal("Boiler is too hot", active.RuleName);
        Assert.Equal(AlertSeverity.Critical, active.Severity);
        // And the sentence it rang about is untouched: Reason says why this alarm exists, and
        // rewriting it on the way back in would lose what it had been complaining about.
        Assert.Equal("94.2 > 90", active.Reason);
    }

    // The restart is a gap nobody watched. A silence rule must give the device its time to speak
    // from the moment the console came back, or every restart rings for everything that was quiet
    // while it was down.
    [Fact]
    public void A_restored_pair_starts_listening_from_now()
    {
        var silence = new AlertRule(
            "quiet", "Nothing from the pump", true, "plant/pump/vibration", null,
            new SilenceCondition(60), null, null, null, AlertSeverity.Warn, [new ScreenAction()]);

        var engine = Engine();
        engine.SetRules([silence], T0);
        engine.OnMessage(Message("0.2", T0, "plant/pump/vibration"), T0);
        engine.Mute("quiet", "plant/pump/vibration", 0, T0);
        var captured = engine.Capture();

        var restarted = Restarted(silence);
        restarted.Restore(captured, T1);

        // Half a minute after the restart, with nothing heard: not yet an hour of silence, and
        // certainly not the five minutes the process spent dead.
        var outcome = restarted.OnTick(T1.AddSeconds(30), connected: true);

        Assert.Empty(outcome.Raised);
    }

    // Restoring onto an engine that was never given its rules answers 'removed' to everything,
    // which is the safe answer: nothing can be shown to be a live rule, so nothing comes back and
    // every endpoint is told its alarm is over.
    [Fact]
    public void Restoring_before_any_rules_are_set_resolves_everything()
    {
        var (engine, _) = Ringing(Hot());

        var outcome = Engine().Restore(engine.Capture(), T1);

        Assert.Equal("rule removed", Assert.Single(outcome.Resolved).ResolvedBy);
    }

    // Capture, restore, capture again: the second file is the first one. A handover that lost a
    // little each time would empty the state over a week of restarts.
    [Fact]
    public void A_captured_state_survives_a_round_trip_through_a_fresh_engine()
    {
        var (engine, _) = Ringing(Hot());
        engine.Mute("hot", "plant/boiler/temp", 30, T0);
        var captured = engine.Capture();

        var restarted = Restarted(Hot());
        restarted.Restore(captured, T1);

        var again = restarted.Capture();
        // Compared member by member rather than record against record: a record's equality stops
        // at the references its lists carry, so two states holding equal lists are not equal, and
        // an Alert's own equality stops at its Actions list for the same reason.
        Assert.Equal(captured.Active.Select(alert => alert.Id), again.Active.Select(alert => alert.Id));
        Assert.Equal(captured.Muted, again.Muted);
        Assert.Equal(captured.Cooldowns, again.Cooldowns);
        Assert.NotNull(captured.Fingerprints);
        Assert.Equal(captured.Fingerprints, again.Fingerprints);
    }
}
