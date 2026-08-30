using System.Globalization;
using MqttForge.Application.Alerts;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Alerts;

// The scenario throughout is the spec's 4-20 mA loop: a line reads 4.0 when it is well and
// sticks at 20.0 when it is not, and a plant has more lines than any one rule should watch.
public class AlertEngineCapsTests
{
    private static readonly DateTimeOffset T0 = new(2026, 8, 30, 9, 0, 0, TimeSpan.Zero);

    private static AlertRule Rule(
        string id,
        string filter,
        double over = 19.0,
        string? jsonPath = null,
        int? cooldown = 0,
        bool enabled = true,
        string name = "Loop current",
        AlertSeverity severity = AlertSeverity.Warn) => new(
        Id: id,
        Name: name,
        Enabled: enabled,
        Filter: filter,
        Field: jsonPath,
        Condition: new ThresholdCondition(ThresholdOp.Gt, over),
        Clear: null,
        For: null,
        Cooldown: cooldown,
        Severity: severity,
        Actions: [new ScreenAction()]);

    private static MqttMessage Msg(string topic, double value, DateTimeOffset at) =>
        new(topic, value.ToString(CultureInfo.InvariantCulture), "text", 0, false, at);

    private static MqttMessage Json(string topic, string body, DateTimeOffset at) =>
        new(topic, body, "text", 0, false, at);

    private static AlertEngineCore Engine(AlertEngineOptions options, params AlertRule[] rules)
    {
        var engine = new AlertEngineCore(options);
        engine.SetRules(rules, T0);
        return engine;
    }

    // Ten thousand quiet lines, one rule. Used by the two caps that count topics.
    private static void Flood(AlertEngineCore engine, string prefix, int topics, DateTimeOffset at)
    {
        for (var i = 0; i < topics; i++)
            engine.OnMessage(Msg($"{prefix}/{i}/mA", 4.0, at), at);
    }

    [Fact]
    public void The_thousand_and_first_topic_is_not_tracked_and_the_rule_is_reported_capped()
    {
        var engine = Engine(new AlertEngineOptions(), Rule("r1", "line/+/mA"));

        Flood(engine, "line", 1001, T0);

        var snapshot = engine.Snapshot();
        Assert.Equal(1000, snapshot.Rules.Single().Topics);
        var capped = Assert.Single(snapshot.Capped);
        Assert.Equal("r1", capped.RuleId);
        Assert.Equal(1, capped.Untracked);
    }

    [Fact]
    public void A_capped_rule_keeps_watching_the_topics_it_already_has()
    {
        var engine = Engine(new AlertEngineOptions(), Rule("r1", "line/+/mA"));
        Flood(engine, "line", 1001, T0);

        // A line it was already watching sticks at 20 mA. The ceiling is about how much the rule
        // may hold, not about whether it still does its job with what it holds.
        var heard = engine.OnMessage(Msg("line/0/mA", 20.0, T0.AddSeconds(5)), T0.AddSeconds(5));
        Assert.Equal("line/0/mA", Assert.Single(heard.Raised).Topic);

        // The one the ceiling refused sticks too, and nothing is heard from it.
        var silent = engine.OnMessage(Msg("line/1000/mA", 20.0, T0.AddSeconds(6)), T0.AddSeconds(6));
        Assert.Empty(silent.Raised);
    }

    [Fact]
    public void An_untracked_topic_is_counted_once_however_often_it_arrives()
    {
        var engine = Engine(new AlertEngineOptions(), Rule("r1", "line/+/mA"));
        Flood(engine, "line", 1000, T0);

        for (var i = 0; i < 50; i++)
        {
            var at = T0.AddMilliseconds(i * 20);
            engine.OnMessage(Msg("line/spare/mA", 4.0, at), at);
        }

        // One topic the rule is not watching. A panel that said "50 topics untracked" for a
        // single chatty device would be reporting the message rate as an inventory.
        Assert.Equal(1, Assert.Single(engine.Snapshot().Capped).Untracked);
    }

    [Fact]
    public void A_per_rule_cap_alone_does_not_bound_the_system()
    {
        // Thirty rules, each obediently under its own thousand-topic ceiling, would be thirty
        // thousand pairs — half again over the system total the memory budget was written for.
        // The ring budget is lifted well out of the way here so that what stops the count is
        // unambiguously MaxPairs.
        var options = new AlertEngineOptions { MaxReadings = 100_000_000 };
        var rules = Enumerable.Range(0, 30).Select(r => Rule($"r{r}", $"line{r}/+/mA")).ToArray();
        var engine = Engine(options, rules);

        for (var r = 0; r < 30; r++)
            Flood(engine, $"line{r}", 1000, T0);

        var snapshot = engine.Snapshot();
        Assert.Equal(30, snapshot.Rules.Count);
        Assert.All(snapshot.Rules, row => Assert.True(row.Topics <= 1000));
        Assert.Equal(20_000, snapshot.Rules.Sum(row => row.Topics));
        Assert.Equal(10_000, snapshot.Capped.Sum(c => c.Untracked));
    }

    [Fact]
    public void The_ring_budget_stops_new_pairs_when_another_ring_would_not_fit()
    {
        // Ten rings of two hundred readings is the whole budget, and the eleventh line has
        // nowhere to live. The two topic ceilings are raised out of the way for the same reason
        // the previous test raised this one.
        var options = new AlertEngineOptions { MaxReadings = 2_000 };
        var engine = Engine(options, Rule("r1", "line/+/mA"));

        Flood(engine, "line", 11, T0);

        var snapshot = engine.Snapshot();
        Assert.Equal(10, snapshot.Rules.Single().Topics);
        Assert.Equal(1, Assert.Single(snapshot.Capped).Untracked);
    }

    [Fact]
    public void A_pair_the_ring_budget_refused_is_never_evaluated()
    {
        var options = new AlertEngineOptions { MaxReadings = 2_000 };
        var engine = Engine(options, Rule("r1", "line/+/mA"));
        Flood(engine, "line", 11, T0);

        var silent = engine.OnMessage(Msg("line/10/mA", 20.0, T0.AddSeconds(1)), T0.AddSeconds(1));

        Assert.Empty(silent.Raised);
        // Ten arrivals were judged, one was refused a pair, and the twelfth message changed
        // neither number. A refused pair is not a pair that answers cheaply; it is not a pair.
        Assert.Equal(10L, engine.Snapshot().Rules.Single().Evaluated);
    }

    [Fact]
    public void At_the_active_alert_cap_no_new_alert_opens_and_suppressed_counts()
    {
        var options = new AlertEngineOptions { MaxActiveAlerts = 3 };
        var engine = Engine(options, Rule("r1", "line/+/mA"));

        for (var i = 0; i < 4; i++)
        {
            var at = T0.AddSeconds(i);
            engine.OnMessage(Msg($"line/{i}/mA", 20.0, at), at);
        }

        var snapshot = engine.Snapshot();
        Assert.Equal(3, snapshot.Active.Count);
        Assert.DoesNotContain(snapshot.Active, a => a.Topic == "line/3/mA");
        Assert.Equal(1, snapshot.Suppressed);
    }

    [Fact]
    public void A_runaway_topic_at_the_cap_is_counted_once_a_second_not_once_a_message()
    {
        var options = new AlertEngineOptions { MaxActiveAlerts = 3 };
        var engine = Engine(options, Rule("r1", "line/+/mA"));
        for (var i = 0; i < 3; i++)
            engine.OnMessage(Msg($"line/{i}/mA", 20.0, T0), T0);

        // A line stuck at 20.0 and shouting fifty times a second is one alert that could not be
        // opened, not fifty.
        for (var i = 0; i < 50; i++)
        {
            var at = T0.AddMilliseconds(i * 20);
            engine.OnMessage(Msg("line/stuck/mA", 20.0, at), at);
        }
        Assert.Equal(1, engine.Snapshot().Suppressed);

        // A second later it asks again, and is told again — once.
        engine.OnMessage(Msg("line/stuck/mA", 20.0, T0.AddSeconds(1)), T0.AddSeconds(1));
        Assert.Equal(2, engine.Snapshot().Suppressed);
    }

    [Fact]
    public void A_freed_slot_lets_a_suppressed_pair_open()
    {
        var options = new AlertEngineOptions { MaxActiveAlerts = 3 };
        var engine = Engine(options, Rule("r1", "line/+/mA"));
        for (var i = 0; i < 3; i++)
            engine.OnMessage(Msg($"line/{i}/mA", 20.0, T0), T0);
        engine.OnMessage(Msg("line/stuck/mA", 20.0, T0), T0);

        // One line comes back to 4 mA and its alert closes on the tick.
        engine.OnMessage(Msg("line/0/mA", 4.0, T0.AddSeconds(2)), T0.AddSeconds(2));
        var closing = engine.OnTick(T0.AddSeconds(3), connected: true);
        Assert.Equal("line/0/mA", Assert.Single(closing.Resolved).Topic);

        // The freed slot goes to the pair the ceiling had been refusing, and it goes there without
        // another message: the stuck line has been true since T0 and was short of nothing but room.
        // Waiting for its next arrival would leave a line that had gone quiet unreported for as
        // long as it stayed quiet, which is the opposite of what a ceiling is for.
        //
        // Whether it opens on the closing tick or the one after depends on the order the pairs are
        // walked in, and that is not a promise this engine makes. That it opens with no further
        // traffic is.
        var opened = closing.Raised
            .Concat(engine.OnTick(T0.AddSeconds(4), connected: true).Raised)
            .ToList();

        Assert.Equal("line/stuck/mA", Assert.Single(opened).Topic);
    }

    [Fact]
    public void History_keeps_the_newest_and_evicts_the_oldest()
    {
        var options = new AlertEngineOptions { HistoryDepth = 3 };
        var engine = Engine(options, Rule("r1", "line/+/mA"));

        for (var i = 0; i < 4; i++)
        {
            var at = T0.AddSeconds(i * 10);
            engine.OnMessage(Msg($"line/{i}/mA", 20.0, at), at);
            engine.OnMessage(Msg($"line/{i}/mA", 4.0, at.AddSeconds(1)), at.AddSeconds(1));
            engine.OnTick(at.AddSeconds(2), connected: true);
        }

        var history = engine.Snapshot().History;
        Assert.Equal(3, history.Count);
        Assert.Equal("line/3/mA", history[0].Topic);
        Assert.DoesNotContain(history, a => a.Topic == "line/0/mA");
    }

    [Fact]
    public void ClearHistory_empties_the_history_and_leaves_the_active_alerts_alone()
    {
        var engine = Engine(new AlertEngineOptions(), Rule("r1", "line/+/mA"));

        engine.OnMessage(Msg("line/0/mA", 20.0, T0), T0);
        engine.OnMessage(Msg("line/0/mA", 4.0, T0.AddSeconds(1)), T0.AddSeconds(1));
        engine.OnTick(T0.AddSeconds(2), connected: true);
        engine.OnMessage(Msg("line/1/mA", 20.0, T0.AddSeconds(3)), T0.AddSeconds(3));

        engine.ClearHistory();

        var snapshot = engine.Snapshot();
        Assert.Empty(snapshot.History);
        Assert.Equal("line/1/mA", Assert.Single(snapshot.Active).Topic);
    }

    [Fact]
    public void A_rule_counts_its_topics_its_evaluations_and_its_skips()
    {
        var engine = Engine(new AlertEngineOptions(),
            Rule("r1", "plant/+/temp", over: 90.0, jsonPath: "$.temp", name: "Boiler temperature"));

        var fired = T0.AddSeconds(1);
        engine.OnMessage(Json("plant/boiler/temp", "{\"temp\":80.0}", T0), T0);
        engine.OnMessage(Json("plant/boiler/temp", "{\"temp\":95.0}", fired), fired);
        // A device saying it is warming up is not a boiler below ninety: the field is absent, so
        // the condition is skipped, and a skip is neither a truth nor a falsehood.
        engine.OnMessage(Json("plant/boiler/temp", "{\"state\":\"warming up\"}", T0.AddSeconds(2)), T0.AddSeconds(2));
        engine.OnMessage(Json("plant/pump/temp", "{\"temp\":10.0}", T0.AddSeconds(3)), T0.AddSeconds(3));
        engine.OnMessage(Json("plant/pump/temp", "{\"state\":\"warming up\"}", T0.AddSeconds(4)), T0.AddSeconds(4));

        var row = Assert.Single(engine.Snapshot().Rules);
        Assert.Equal(2, row.Topics);
        Assert.Equal(3L, row.Evaluated);
        Assert.Equal(2L, row.Skipped);
        Assert.Equal(fired, row.LastFiredAt);
    }

    [Fact]
    public void A_rule_that_matches_no_topic_reports_no_topics_rather_than_no_row()
    {
        var engine = Engine(new AlertEngineOptions(), Rule("r1", "plant/#"));

        engine.OnMessage(Msg("lab/bench/mA", 20.0, T0), T0);

        // The one question the panel exists to answer is "why has this rule never said anything",
        // and a rule that is silently missing from the diagnostics looks exactly like a rule that
        // is quietly working.
        var row = Assert.Single(engine.Snapshot().Rules);
        Assert.Equal("r1", row.RuleId);
        Assert.Equal(0, row.Topics);
        Assert.Equal(0L, row.Evaluated);
        Assert.Equal(0L, row.Skipped);
        Assert.Null(row.LastFiredAt);
        Assert.False(row.Faulted);
        Assert.Null(row.FaultReason);
    }

    [Fact]
    public void Editing_what_a_rule_watches_resets_its_diagnostics()
    {
        var engine = Engine(new AlertEngineOptions(), Rule("r1", "line/+/mA"));
        engine.OnMessage(Msg("line/0/mA", 20.0, T0), T0);
        Assert.Equal(1L, engine.Snapshot().Rules.Single().Evaluated);

        // The threshold moves. What the rule saw before this is not evidence about the rule that
        // exists after it.
        engine.SetRules([Rule("r1", "line/+/mA", over: 21.0)], T0.AddSeconds(1));

        var row = engine.Snapshot().Rules.Single();
        Assert.Equal(0L, row.Evaluated);
        Assert.Equal(0L, row.Skipped);
        Assert.Null(row.LastFiredAt);
    }

    [Fact]
    public void Toggling_a_rule_off_and_on_resets_its_diagnostics_and_keeps_its_pairs()
    {
        var engine = Engine(new AlertEngineOptions(), Rule("r1", "line/+/mA"));
        engine.OnMessage(Msg("line/0/mA", 4.0, T0), T0);

        engine.SetRules([Rule("r1", "line/+/mA", enabled: false)], T0.AddSeconds(1));
        engine.SetRules([Rule("r1", "line/+/mA", enabled: true)], T0.AddSeconds(2));

        var row = engine.Snapshot().Rules.Single();
        Assert.Equal(0L, row.Evaluated);
        // Enabled is outside ConfigHash, so the pair — and the ring behind it — outlives a brief
        // disable. Only the counters go, because a count that spans a period the rule was not
        // running is a count of nothing in particular.
        Assert.Equal(1, row.Topics);
    }

    [Fact]
    public void Renaming_a_rule_keeps_its_diagnostics()
    {
        var engine = Engine(new AlertEngineOptions(), Rule("r1", "line/+/mA"));
        engine.OnMessage(Msg("line/0/mA", 4.0, T0), T0);

        // Name, Severity, Cooldown and Actions are outside ConfigHash on purpose. The counters
        // answer "what has this rule seen", and none of these four change what it sees.
        engine.SetRules(
            [Rule("r1", "line/+/mA", name: "Loop current, upper", cooldown: 60, severity: AlertSeverity.Critical)],
            T0.AddSeconds(1));

        Assert.Equal(1L, engine.Snapshot().Rules.Single().Evaluated);
    }

    [Fact]
    public void A_removed_rule_takes_its_row_and_its_cap_report_with_it()
    {
        var engine = Engine(new AlertEngineOptions(), Rule("r1", "line/+/mA"));
        Flood(engine, "line", 1001, T0);
        Assert.Single(engine.Snapshot().Capped);

        engine.SetRules([], T0.AddSeconds(1));

        var snapshot = engine.Snapshot();
        Assert.Empty(snapshot.Rules);
        Assert.Empty(snapshot.Capped);
    }
}
