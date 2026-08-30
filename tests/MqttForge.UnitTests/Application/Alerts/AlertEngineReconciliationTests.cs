using MqttForge.Application.Alerts;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Alerts;

/// <summary>
/// What a save does to an engine that is already running, which is the half of saving that has
/// nothing to do with the file.
///
/// The first outcome is the one that has to exist: Clear only runs on arrival, and only while an
/// alert is active. A rule whose filter the user has just changed will never receive another
/// message on its old topic, so its alert would never clear, the resolved body would never be
/// sent, and the webhook endpoint would hold an open alarm for a rule that no longer exists.
/// Dropping the state is not tidiness — it is the only thing that closes the promise.
///
/// The third outcome is the one that is easy to get wrong: PUT always carries the whole list,
/// because the panel has no notion of a partial save, so a save aimed at one rule passes every
/// other rule through this code as well.
/// </summary>
public class AlertEngineReconciliationTests
{
    private static readonly DateTimeOffset T0 = new(2026, 8, 30, 9, 0, 0, TimeSpan.Zero);
    private static readonly DateTimeOffset T1 = T0.AddSeconds(10);

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

    private static MqttMessage Message(string topic, string payload, DateTimeOffset at) =>
        new(topic, payload, "text", Qos: 0, Retain: false, at);

    /// An engine with one alarm ringing, and the alarm itself, so a test can prove that what it
    /// is looking at afterwards is the same alert rather than a replacement.
    private static (AlertEngineCore Engine, Alert Ringing) Ringing(AlertRule rule)
    {
        var engine = Engine();
        engine.SetRules([rule], T0);
        var outcome = engine.OnMessage(Message("plant/boiler/temp", "94.2", T0), T0);
        return (engine, Assert.Single(outcome.Raised));
    }

    // ── (a) the state is dropped and the alert resolves ──────────────────────────────────────

    [Fact]
    public void A_changed_rule_drops_its_state_and_resolves_with_rule_changed()
    {
        var (engine, ringing) = Ringing(Hot());

        var outcome = engine.SetRules([Hot(over: 95)], T1);

        var resolved = Assert.Single(outcome.Resolved);
        Assert.Equal(ringing.Id, resolved.Id);
        Assert.Equal("rule changed", resolved.ResolvedBy);
        Assert.Equal(T1, resolved.ResolvedAt);
        Assert.Empty(engine.Snapshot().Active);
        Assert.Contains(engine.Snapshot().History, alert => alert.Id == resolved.Id);
        Assert.Equal(0, Assert.Single(engine.Snapshot().Rules).Topics);
    }

    [Fact]
    public void A_disabled_rule_resolves_with_rule_disabled()
    {
        var (engine, _) = Ringing(Hot());

        var outcome = engine.SetRules([Hot(enabled: false)], T1);

        Assert.Equal("rule disabled", Assert.Single(outcome.Resolved).ResolvedBy);
        Assert.Empty(engine.Snapshot().Active);
        // Still listed, and listed as having nothing: off has to look different from absent when
        // someone is asking why nothing has gone off all week.
        Assert.Equal(0, Assert.Single(engine.Snapshot().Rules).Topics);
    }

    [Fact]
    public void A_removed_rule_resolves_with_rule_removed()
    {
        var (engine, _) = Ringing(Hot());

        var outcome = engine.SetRules([], T1);

        Assert.Equal("rule removed", Assert.Single(outcome.Resolved).ResolvedBy);
        Assert.Empty(engine.Snapshot().Active);
        // And a removed rule really is absent — that is the whole difference between the two
        // sentences above, and it is the difference the panel draws.
        Assert.Empty(engine.Snapshot().Rules);
    }

    // The resolutions have to come back out, or the webhook and the MQTT dispatcher never learn
    // that the alarm ended and the endpoint is left holding it. Nothing else in the engine tells
    // them: SetRules is not on the message path and no tick follows it.
    [Fact]
    public void Every_alert_a_save_ends_comes_back_in_the_outcome()
    {
        var engine = Engine();
        engine.SetRules([Hot(filter: "plant/#")], T0);
        engine.OnMessage(Message("plant/a/temp", "94.2", T0), T0);
        engine.OnMessage(Message("plant/b/temp", "95.3", T0), T0);

        var outcome = engine.SetRules([Hot(filter: "plant/#", over: 99)], T1);

        Assert.Equal(2, outcome.Resolved.Count);
        Assert.All(outcome.Resolved, alert => Assert.Equal("rule changed", alert.ResolvedBy));
        Assert.Equal(
            ["plant/a/temp", "plant/b/temp"],
            outcome.Resolved.Select(alert => alert.Topic).Order());
    }

    // Two saves, one alert. The drop happens on the save that switched the rule off; the save
    // that deletes it has nothing left to end. A second resolved body for the same alert would
    // be the endpoint's problem to untangle, and it has no way to.
    [Fact]
    public void A_rule_disabled_and_then_removed_resolves_its_alert_once()
    {
        var (engine, _) = Ringing(Hot());

        var first = engine.SetRules([Hot(enabled: false)], T1);
        var second = engine.SetRules([], T1.AddSeconds(1));

        Assert.Single(first.Resolved);
        Assert.Empty(second.Resolved);
    }

    // Filter is inside the hash, so this is really outcome (a) again — but it is the scenario
    // the outcome was written for, and the thing worth asserting is the absence afterwards: the
    // old pair must be gone, not merely quiet.
    [Fact]
    public void A_rule_whose_filter_changed_leaves_no_pair_behind()
    {
        var (engine, _) = Ringing(Hot());

        var outcome = engine.SetRules([Hot(filter: "plant/+/pressure")], T1);

        Assert.Equal("rule changed", Assert.Single(outcome.Resolved).ResolvedBy);

        // A message on the old topic must not revive the pair the save just dropped.
        engine.OnMessage(Message("plant/boiler/temp", "99", T1.AddSeconds(1)), T1.AddSeconds(1));

        Assert.Equal(0, Assert.Single(engine.Snapshot().Rules).Topics);
        Assert.Empty(engine.Snapshot().Active);
    }

    // Switched off and straight back on with nothing else touched: the hash matches again, but
    // there is nothing to match it against — the state went when the rule went off. It starts
    // again, and in particular the alarm does not come back to life without a message.
    [Fact]
    public void A_rule_switched_off_and_back_on_starts_again_rather_than_waking_up()
    {
        var (engine, _) = Ringing(Hot());
        engine.SetRules([Hot(enabled: false)], T1);

        var outcome = engine.SetRules([Hot()], T1.AddSeconds(1));

        Assert.Empty(outcome.Resolved);
        Assert.Empty(engine.Snapshot().Active);
        Assert.Equal(0, Assert.Single(engine.Snapshot().Rules).Topics);
    }

    // ── (b) only the wording changed ─────────────────────────────────────────────────────────

    [Fact]
    public void Renaming_a_rule_keeps_the_alert_and_updates_it_in_place()
    {
        var (engine, ringing) = Ringing(Hot(severity: AlertSeverity.Warn));

        var outcome = engine.SetRules(
            [Hot(name: "Boiler is too hot", severity: AlertSeverity.Critical)], T1);

        Assert.Empty(outcome.Resolved);
        var active = Assert.Single(engine.Snapshot().Active);
        Assert.Equal(ringing.Id, active.Id);
        Assert.Equal(ringing.FiredAt, active.FiredAt);
        Assert.Equal("Boiler is too hot", active.RuleName);
        Assert.Equal(AlertSeverity.Critical, active.Severity);
    }

    [Fact]
    public void Saving_an_unchanged_rule_resolves_nothing_and_keeps_the_pair()
    {
        var (engine, ringing) = Ringing(Hot());

        var outcome = engine.SetRules([Hot()], T1);

        Assert.Empty(outcome.Resolved);
        Assert.Equal(ringing.Id, Assert.Single(engine.Snapshot().Active).Id);
        Assert.Equal(1, Assert.Single(engine.Snapshot().Rules).Topics);
    }

    // LastSeen is the whole of what a silence rule knows, and a save that reset it would push
    // every silence alert out by however long the rule had already been waiting — at exactly the
    // moment a user editing rules is least likely to notice.
    [Fact]
    public void Saving_does_not_restart_a_silence_rules_clock()
    {
        var engine = Engine();
        var quiet = new AlertRule("quiet", "Pump has gone quiet", Enabled: true, "plant/+/temp",
            Field: null, new SilenceCondition(30), Clear: null, For: null, Cooldown: null,
            AlertSeverity.Warn, [new ScreenAction()]);
        engine.SetRules([quiet], T0);
        engine.OnMessage(Message("plant/boiler/temp", "20.1", T0), T0);

        // Renamed twenty-five seconds in. Nothing that decides when it fires has changed.
        engine.SetRules([quiet with { Name = "Pump is silent" }], T0.AddSeconds(25));

        Assert.Empty(engine.OnTick(T0.AddSeconds(29), connected: true).Raised);
        Assert.Single(engine.OnTick(T0.AddSeconds(31), connected: true).Raised);
    }

    // ── (c) an untouched rule is not disturbed ───────────────────────────────────────────────

    // The one the spec asks for by name. Rule 'cold' is renamed; rule 'hot' is inside a sixty
    // second cooldown and is not being edited at all — but it travels through the same save,
    // because the whole list always does.
    [Fact]
    public void Saving_the_whole_list_does_not_reset_another_rules_cooldown()
    {
        var engine = Engine();
        var hot = Hot("hot", cooldown: 60) with
        {
            Clear = new ThresholdCondition(ThresholdOp.Lt, 80),
        };
        var cold = Hot("cold", filter: "plant/+/inlet", over: 5, name: "Inlet temperature");
        engine.SetRules([hot, cold], T0);

        Assert.Single(engine.OnMessage(Message("plant/boiler/temp", "94.2", T0), T0).Raised);
        engine.OnMessage(Message("plant/boiler/temp", "70", T0.AddSeconds(1)), T0.AddSeconds(1));
        Assert.Single(engine.OnTick(T0.AddSeconds(2), connected: true).Resolved);

        engine.SetRules([hot, cold with { Name = "Inlet is cold" }], T0.AddSeconds(3));

        // Still inside the cooldown: if the save had reset it, this would ring.
        Assert.Empty(engine
            .OnMessage(Message("plant/boiler/temp", "96", T0.AddSeconds(4)), T0.AddSeconds(4))
            .Raised);

        // And past it, so the test cannot pass by the rule being broken instead.
        Assert.Single(engine
            .OnMessage(Message("plant/boiler/temp", "97", T0.AddSeconds(70)), T0.AddSeconds(70))
            .Raised);
    }

    [Fact]
    public void Changing_one_rule_does_not_resolve_another_rules_alert()
    {
        var engine = Engine();
        engine.SetRules([Hot("hot"), Hot("warm", over: 50, name: "Boiler warm")], T0);
        var raised = engine.OnMessage(Message("plant/boiler/temp", "94.2", T0), T0);
        Assert.Equal(2, raised.Raised.Count);

        var outcome = engine.SetRules([Hot("hot", over: 95), Hot("warm", over: 50,
            name: "Boiler warm")], T1);

        Assert.Equal("hot", Assert.Single(outcome.Resolved).RuleId);
        Assert.Equal("warm", Assert.Single(engine.Snapshot().Active).RuleId);
    }

    // ── the empty and awkward shapes ─────────────────────────────────────────────────────────

    [Fact]
    public void Setting_an_empty_rule_set_on_a_fresh_engine_resolves_nothing()
    {
        var outcome = Engine().SetRules([], T0);

        Assert.Empty(outcome.Raised);
        Assert.Empty(outcome.Resolved);
    }

    [Fact]
    public void A_save_that_ends_nothing_returns_the_empty_outcome()
    {
        var engine = Engine();
        engine.SetRules([Hot()], T0);

        Assert.Same(EngineOutcome.Empty, engine.SetRules([Hot()], T1));
    }

    // A rule that never matched anything has no pair, so there is nothing to drop and nothing to
    // resolve — the path that walks pairs must not assume every rule has one.
    [Fact]
    public void Changing_a_rule_that_never_matched_a_topic_resolves_nothing()
    {
        var engine = Engine();
        engine.SetRules([Hot()], T0);
        engine.OnMessage(Message("other/thing", "94.2", T0), T0);

        Assert.Empty(engine.SetRules([Hot(over: 95)], T1).Resolved);
    }
}
