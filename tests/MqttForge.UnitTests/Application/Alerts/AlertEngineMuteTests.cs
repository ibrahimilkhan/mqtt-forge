using System.Globalization;
using MqttForge.Application.Alerts;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Alerts;

// The spec's own worked example throughout, so these tests read as the thing they describe:
// plant/boiler/temp carrying {"temp": 94.2}, fire above 90, clear below 85.
public class AlertEngineMuteTests
{
    private static readonly DateTimeOffset T0 = new(2026, 8, 30, 9, 0, 0, TimeSpan.Zero);

    private const string Boiler = "plant/boiler/temp";

    private static AlertRule BoilerRule(
        string name = "Boiler temperature",
        double fireAbove = 90.0,
        int? cooldown = 0) => new(
        Id: "r1",
        Name: name,
        Enabled: true,
        Filter: "plant/+/temp",
        Field: "$.temp",
        Condition: new ThresholdCondition(ThresholdOp.Gt, fireAbove),
        Clear: new ThresholdCondition(ThresholdOp.Lt, 85.0),
        For: null,
        // Zero, not the one-second default. These tests decide for themselves when a pair may
        // fire again by moving 'now'; a cooldown they did not ask for would swallow a raise and
        // leave the mute looking like it worked.
        Cooldown: cooldown,
        Severity: AlertSeverity.Critical,
        Actions: [new ScreenAction()]);

    private static MqttMessage Temp(double celsius, DateTimeOffset at, string topic = Boiler) =>
        new(topic,
            $"{{\"temp\":{celsius.ToString(CultureInfo.InvariantCulture)}}}",
            "text", 0, false, at);

    private static AlertEngineCore Engine(params AlertRule[] rules)
    {
        AlertRule[] set = rules.Length == 0 ? [BoilerRule()] : rules;
        var engine = new AlertEngineCore(new AlertEngineOptions());
        engine.SetRules(set, T0);
        return engine;
    }

    // Puts the pair on the board with one quiet reading. Mute addresses a (rule, topic) pair and
    // there is no pair until a message has matched, so every test that mutes starts here.
    private static AlertEngineCore Seen(DateTimeOffset at)
    {
        var engine = Engine();
        engine.OnMessage(Temp(70.0, at), at);
        return engine;
    }

    [Fact]
    public void A_muted_pair_still_fires_and_still_counts_but_the_raise_is_not_announced()
    {
        var engine = Seen(T0);
        engine.Mute("r1", Boiler, 30, T0);

        var first = engine.OnMessage(Temp(94.2, T0.AddSeconds(1)), T0.AddSeconds(1));
        engine.OnMessage(Temp(95.0, T0.AddSeconds(2)), T0.AddSeconds(2));
        engine.OnMessage(Temp(96.0, T0.AddSeconds(3)), T0.AddSeconds(3));

        Assert.Empty(first.Raised);

        // "Stop telling me", not "forget the condition": the boiler is still over ninety, the
        // engine still knows it, and the count is still climbing behind the silence.
        var alert = Assert.Single(engine.Snapshot().Active);
        Assert.Equal(Boiler, alert.Topic);
        Assert.Equal(3, alert.Count);
        Assert.Equal(T0.AddMinutes(30), alert.MutedUntil);
    }

    [Fact]
    public void A_muted_pair_does_not_announce_the_resolve_either()
    {
        var engine = Seen(T0);
        engine.Mute("r1", Boiler, 30, T0);
        engine.OnMessage(Temp(94.2, T0.AddSeconds(1)), T0.AddSeconds(1));

        engine.OnMessage(Temp(80.0, T0.AddSeconds(2)), T0.AddSeconds(2));
        var tick = engine.OnTick(T0.AddSeconds(3), connected: true);

        Assert.Empty(tick.Resolved);
        Assert.Empty(engine.Snapshot().Active);

        // The history is a record of what happened, and what happened happened. Silence is a
        // delivery decision, not an amnesty.
        var resolved = Assert.Single(engine.Snapshot().History);
        Assert.Equal("clear", resolved.ResolvedBy);
    }

    [Fact]
    public void A_mute_outlives_the_alert_it_was_set_on()
    {
        var engine = Seen(T0);
        engine.Mute("r1", Boiler, 30, T0);

        engine.OnMessage(Temp(94.2, T0.AddSeconds(1)), T0.AddSeconds(1));
        engine.OnMessage(Temp(80.0, T0.AddSeconds(2)), T0.AddSeconds(2));
        engine.OnTick(T0.AddSeconds(3), connected: true);

        var second = engine.OnMessage(Temp(95.0, T0.AddSeconds(4)), T0.AddSeconds(4));

        // A second alert, with a second id — and still silent. This is the whole reason the mute
        // is keyed on the pair: keyed on the alert it would have expired with the first one.
        Assert.Empty(second.Raised);
        var opened = Assert.Single(engine.Snapshot().Active);
        var closed = Assert.Single(engine.Snapshot().History);
        Assert.NotEqual(closed.Id, opened.Id);
    }

    [Fact]
    public void A_mute_ends_exactly_on_its_deadline()
    {
        static EngineOutcome FireAt(DateTimeOffset at)
        {
            var engine = Seen(T0);
            engine.Mute("r1", Boiler, 5, T0);
            return engine.OnMessage(Temp(94.2, at), at);
        }

        Assert.Empty(FireAt(T0.AddMinutes(5).AddMilliseconds(-1)).Raised);
        Assert.Single(FireAt(T0.AddMinutes(5)).Raised);
    }

    [Fact]
    public void The_tick_takes_an_expired_mute_off_the_muted_list()
    {
        var engine = Seen(T0);
        engine.Mute("r1", Boiler, 5, T0);

        engine.OnTick(T0.AddMinutes(5).AddMilliseconds(-1), connected: true);
        Assert.Single(engine.Snapshot().Muted);

        engine.OnTick(T0.AddMinutes(5), connected: true);
        Assert.Empty(engine.Snapshot().Muted);
    }

    [Fact]
    public void Zero_minutes_lifts_the_mute()
    {
        var engine = Seen(T0);
        engine.Mute("r1", Boiler, 30, T0);
        engine.Mute("r1", Boiler, 0, T0.AddMinutes(1));

        Assert.Empty(engine.Snapshot().Muted);

        var raised = engine.OnMessage(Temp(94.2, T0.AddMinutes(2)), T0.AddMinutes(2));
        Assert.Equal(Boiler, Assert.Single(raised.Raised).Topic);
    }

    [Fact]
    public void Lifting_a_mute_clears_the_label_on_the_alert_it_faded()
    {
        var engine = Seen(T0);
        engine.Mute("r1", Boiler, 30, T0);
        engine.OnMessage(Temp(94.2, T0.AddSeconds(1)), T0.AddSeconds(1));

        engine.Mute("r1", Boiler, 0, T0.AddSeconds(2));

        Assert.Null(Assert.Single(engine.Snapshot().Active).MutedUntil);
    }

    [Fact]
    public void Muting_a_pair_the_engine_has_never_seen_is_a_no_op()
    {
        var engine = Engine();

        var unseenTopic = engine.Mute("r1", Boiler, 30, T0);
        var unknownRule = engine.Mute("no-such-rule", Boiler, 30, T0);

        Assert.Empty(unseenTopic.Raised);
        Assert.Empty(unseenTopic.Resolved);
        Assert.Empty(unknownRule.Raised);
        Assert.Empty(unknownRule.Resolved);
        Assert.Empty(engine.Snapshot().Muted);

        // And it did not quietly bring the pair into being on the way past: the boiler's first
        // real reading is heard, exactly as if nobody had touched anything.
        var raised = engine.OnMessage(Temp(94.2, T0.AddSeconds(1)), T0.AddSeconds(1));
        Assert.Single(raised.Raised);
    }

    [Fact]
    public void Muted_lists_a_pair_that_has_no_alert_at_all()
    {
        var engine = Seen(T0);
        engine.Mute("r1", Boiler, 30, T0);

        var pair = Assert.Single(engine.Snapshot().Muted);
        Assert.Equal("r1", pair.RuleId);
        Assert.Equal(Boiler, pair.Topic);
        Assert.Equal(T0.AddMinutes(30), pair.Until);
        Assert.Empty(engine.Snapshot().Active);
    }

    [Fact]
    public void A_mute_longer_than_a_day_is_clamped_to_a_day()
    {
        var engine = Seen(T0);

        engine.Mute("r1", Boiler, 10_000, T0);

        Assert.Equal(T0.AddMinutes(AlertEngineCore.MaxMuteMinutes), Assert.Single(engine.Snapshot().Muted).Until);
    }

    [Fact]
    public void Renaming_the_rule_keeps_the_mute()
    {
        var engine = Seen(T0);
        engine.Mute("r1", Boiler, 30, T0);

        // The mute lives on the pair, so it lives exactly as long as the pair does. Nothing drops
        // a pair yet — that is task 15 — and this test is here so that when the reconciliation
        // arrives it cannot quietly take the mute with it: Name is outside ConfigHash, the pair
        // survives, and a user who muted the boiler for half an hour does not expect it to start
        // shouting because somebody fixed a typo in the rule's name.
        engine.SetRules([BoilerRule(name: "Boiler temperature, upper")], T0.AddSeconds(1));

        Assert.Single(engine.Snapshot().Muted);
        Assert.Empty(engine.OnMessage(Temp(94.2, T0.AddSeconds(2)), T0.AddSeconds(2)).Raised);
    }
}
