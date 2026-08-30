using MqttForge.Application.Alerts;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using Xunit;

namespace MqttForge.UnitTests.Application.Alerts;

// The core has no clock, so none of this sleeps and none of it needs a fake time provider: the
// instant is an argument, and the same sequence of arguments always produces the same output.
public class AlertEngineCoreTests
{
    private static readonly DateTimeOffset Start = new(2026, 8, 30, 9, 0, 0, TimeSpan.Zero);
    private static readonly AlertEngineOptions Options = new();

    private static AlertCondition Over90 => new ThresholdCondition(ThresholdOp.Gt, 90);

    private static AlertRule Rule(
        string id,
        string filter,
        AlertCondition condition,
        string? field = null,
        bool enabled = true,
        AlertSeverity severity = AlertSeverity.Critical) =>
        new(id, "Boiler temperature", enabled, filter, field, condition,
            null, null, null, severity, [new ScreenAction()]);

    private static MqttMessage Message(string topic, string payload, DateTimeOffset at, bool replay = false) =>
        new(topic, payload, "text", 0, false, at, replay);

    [Fact]
    public void SetRules_creates_no_pairs_and_raises_nothing()
    {
        var engine = new AlertEngineCore(Options);

        var outcome = engine.SetRules([Rule("boiler", "plant/+/temp", Over90)], Start);

        Assert.Same(EngineOutcome.Empty, outcome);
        var snapshot = engine.Snapshot();
        Assert.Empty(snapshot.Active);
        // A filter is not an inventory: until a message arrives there is no topic to pair with,
        // and a wildcard rule would otherwise have to guess at a broker's whole tree.
        Assert.Equal(0, Assert.Single(snapshot.Rules).Topics);
    }

    [Fact]
    public void A_message_matching_no_rule_does_nothing()
    {
        var engine = new AlertEngineCore(Options);
        engine.SetRules([Rule("boiler", "plant/+/temp", Over90)], Start);

        var outcome = engine.OnMessage(Message("plant/boiler/pressure", "95", Start), Start);

        // The same instance, not merely an equal one: a topic nobody wrote a rule for is most of
        // the traffic, and it must not cost two allocations fifty times a second.
        Assert.Same(EngineOutcome.Empty, outcome);
        Assert.Equal(0, Assert.Single(engine.Snapshot().Rules).Topics);
    }

    [Fact]
    public void A_matching_message_with_a_true_condition_raises_one_alert()
    {
        var engine = new AlertEngineCore(Options);
        engine.SetRules([Rule("boiler", "plant/+/temp", Over90)], Start);

        var outcome = engine.OnMessage(Message("plant/boiler/temp", "95", Start), Start);

        var alert = Assert.Single(outcome.Raised);
        Assert.Empty(outcome.Resolved);
        Assert.Equal("boiler", alert.RuleId);
        Assert.Equal("Boiler temperature", alert.RuleName);
        Assert.Equal("plant/boiler/temp", alert.Topic);
        Assert.Equal(AlertSeverity.Critical, alert.Severity);
        Assert.Equal(Start, alert.FiredAt);
        Assert.Equal(Start, alert.LastSeenAt);
        Assert.Null(alert.ResolvedAt);
        Assert.Null(alert.ResolvedBy);
        Assert.Equal(1, alert.Count);
        // The number that decided it travels with the alarm from here. The sentence built around
        // that number is task 8's — nothing is asserted about Reason or Sample in this file,
        // because task 8 fills both and a test pinning them empty here would go red when it did.
        Assert.Equal(95, alert.Value);
        Assert.Same(alert, Assert.Single(engine.Snapshot().Active));

        var diagnostic = Assert.Single(engine.Snapshot().Rules);
        Assert.Equal(1, diagnostic.Topics);
        Assert.Equal(1, diagnostic.Evaluated);
        Assert.Equal(0, diagnostic.Skipped);
    }

    // Fifty messages a second from a boiler over ninety is one alarm, not fifty.
    [Fact]
    public void Fifty_more_matching_messages_only_bump_the_count_and_the_last_seen()
    {
        var engine = new AlertEngineCore(Options);
        engine.SetRules([Rule("boiler", "plant/+/temp", Over90)], Start);
        var first = engine.OnMessage(Message("plant/boiler/temp", "95", Start), Start);

        var raisedLater = 0;
        var at = Start;
        for (var i = 1; i <= 50; i++)
        {
            at = Start.AddMilliseconds(20 * i);
            raisedLater += engine.OnMessage(Message("plant/boiler/temp", "95.4", at), at).Raised.Count;
        }

        Assert.Equal(0, raisedLater);
        var alert = Assert.Single(engine.Snapshot().Active);
        Assert.Equal(Assert.Single(first.Raised).Id, alert.Id);
        Assert.Equal(51, alert.Count);
        Assert.Equal(at, alert.LastSeenAt);
        Assert.Equal(Start, alert.FiredAt);
        // The value does not drift with the traffic: an alert that said 95 and then quietly
        // rewrote itself to 95.4 loses the reading that made someone get up.
        Assert.Equal(95, alert.Value);
        Assert.Equal(51, Assert.Single(engine.Snapshot().Rules).Evaluated);
    }

    [Fact]
    public void The_condition_going_false_does_not_resolve_on_arrival()
    {
        var engine = new AlertEngineCore(Options);
        engine.SetRules([Rule("boiler", "plant/+/temp", Over90)], Start);
        engine.OnMessage(Message("plant/boiler/temp", "95", Start), Start);

        var outcome = engine.OnMessage(Message("plant/boiler/temp", "85", Start.AddSeconds(1)), Start.AddSeconds(1));

        Assert.Empty(outcome.Resolved);
        Assert.Single(engine.Snapshot().Active);
    }

    [Fact]
    public void The_next_tick_resolves_what_arrival_saw_go_false()
    {
        var engine = new AlertEngineCore(Options);
        engine.SetRules([Rule("boiler", "plant/+/temp", Over90)], Start);
        var raised = Assert.Single(engine.OnMessage(Message("plant/boiler/temp", "95", Start), Start).Raised);
        engine.OnMessage(Message("plant/boiler/temp", "85", Start.AddSeconds(1)), Start.AddSeconds(1));

        var tick = engine.OnTick(Start.AddSeconds(2), connected: true);

        var resolved = Assert.Single(tick.Resolved);
        Assert.Equal(raised.Id, resolved.Id);
        Assert.Equal("clear", resolved.ResolvedBy);
        Assert.Equal(Start.AddSeconds(2), resolved.ResolvedAt);
        Assert.Empty(engine.Snapshot().Active);
        Assert.Equal(resolved.Id, Assert.Single(engine.Snapshot().History).Id);
        // And it stays resolved: a second tick has nothing left to close.
        Assert.Empty(engine.OnTick(Start.AddSeconds(3), connected: true).Resolved);
    }

    // The spec's flapping signal: fifty messages a second either side of ninety. Firing on
    // arrival and resolving only on the tick is what holds a pair to one state change a second.
    [Fact]
    public void A_flapping_signal_makes_at_most_one_state_change_in_a_second()
    {
        var engine = new AlertEngineCore(Options);
        engine.SetRules([Rule("boiler", "plant/+/temp", Over90)], Start);

        var raised = 0;
        var resolved = 0;
        for (var i = 0; i < 50; i++)
        {
            var at = Start.AddMilliseconds(20 * i);
            var outcome = engine.OnMessage(Message("plant/boiler/temp", i % 2 == 0 ? "90.1" : "89.9", at), at);
            raised += outcome.Raised.Count;
            resolved += outcome.Resolved.Count;
        }

        Assert.Equal(1, raised);
        Assert.Equal(0, resolved);
        // The last reading was 89.9, so the second's other change lands here — and only here.
        Assert.Single(engine.OnTick(Start.AddSeconds(1), connected: true).Resolved);
    }

    [Fact]
    public void A_replay_message_is_not_judged_and_leaves_no_pair_behind()
    {
        var engine = new AlertEngineCore(Options);
        engine.SetRules([Rule("boiler", "plant/+/temp", Over90)], Start);

        var outcome = engine.OnMessage(Message("plant/boiler/temp", "95", Start, replay: true), Start);

        Assert.Same(EngineOutcome.Empty, outcome);
        var diagnostic = Assert.Single(engine.Snapshot().Rules);
        // No pair at all, which is also the only place a last-seen stamp could have been kept:
        // a device that died an hour ago must not look alive because the broker replayed it.
        Assert.Equal(0, diagnostic.Topics);
        Assert.Equal(0, diagnostic.Evaluated);
        Assert.Equal(0, diagnostic.Skipped);

        // The live message right behind it is judged normally.
        var live = engine.OnMessage(Message("plant/boiler/temp", "95", Start.AddSeconds(3)), Start.AddSeconds(3));
        Assert.Single(live.Raised);
    }

    [Fact]
    public void A_message_on_the_alert_prefix_is_ignored_entirely()
    {
        var engine = new AlertEngineCore(Options);
        engine.SetRules([Rule("everything", "#", new ThresholdCondition(ThresholdOp.Gt, 0))], Start);

        var outcome = engine.OnMessage(
            Message("mqttforge/alerts/everything/plant/boiler/temp", "1", Start), Start);

        // Our own alarm falls back into a '#' subscription. Judging it would have the alarm
        // raise an alarm, for ever.
        Assert.Same(EngineOutcome.Empty, outcome);
        Assert.Equal(0, Assert.Single(engine.Snapshot().Rules).Topics);
        // The same rule still judges everything outside the prefix.
        Assert.Single(engine.OnMessage(Message("plant/boiler/temp", "1", Start), Start).Raised);
    }

    [Fact]
    public void A_disabled_rule_is_never_evaluated()
    {
        var engine = new AlertEngineCore(Options);
        engine.SetRules([Rule("boiler", "plant/+/temp", Over90, enabled: false)], Start);

        var outcome = engine.OnMessage(Message("plant/boiler/temp", "95", Start), Start);

        Assert.Same(EngineOutcome.Empty, outcome);
        // Still listed, because a rule that is off has to be visible as off rather than absent
        // when someone is asking why nothing has gone off all week. This is the behaviour the
        // whole plan keeps: task 15's removed-rule test is the only one that expects an empty
        // list, and a removed rule really is absent.
        var diagnostic = Assert.Single(engine.Snapshot().Rules);
        Assert.Equal(0, diagnostic.Topics);
        Assert.Equal(0, diagnostic.Evaluated);
    }

    // A device saying 'warming up' is not a device below ten.
    [Fact]
    public void A_payload_the_field_is_not_in_is_skipped_rather_than_counted_false()
    {
        var engine = new AlertEngineCore(Options);
        engine.SetRules(
            [Rule("boiler", "plant/+/temp", new ThresholdCondition(ThresholdOp.Lt, 10), field: "$.temp")],
            Start);

        var outcome = engine.OnMessage(Message("plant/boiler/temp", "warming up", Start), Start);

        Assert.Empty(outcome.Raised);
        var diagnostic = Assert.Single(engine.Snapshot().Rules);
        Assert.Equal(1, diagnostic.Topics);
        Assert.Equal(0, diagnostic.Evaluated);
        Assert.Equal(1, diagnostic.Skipped);
    }

    [Fact]
    public void A_skipped_message_leaves_an_active_alert_where_it_was()
    {
        var engine = new AlertEngineCore(Options);
        engine.SetRules([Rule("boiler", "plant/+/temp", Over90, field: "$.temp")], Start);
        engine.OnMessage(Message("plant/boiler/temp", """{"temp":95}""", Start), Start);

        engine.OnMessage(Message("plant/boiler/temp", "warming up", Start.AddSeconds(1)), Start.AddSeconds(1));
        var tick = engine.OnTick(Start.AddSeconds(2), connected: true);

        // Never judged is not judged false: the boiler is still over ninety as far as anyone knows.
        Assert.Empty(tick.Resolved);
        var alert = Assert.Single(engine.Snapshot().Active);
        Assert.Equal(1, alert.Count);
        Assert.Equal(Start, alert.LastSeenAt);
        var diagnostic = Assert.Single(engine.Snapshot().Rules);
        Assert.Equal(1, diagnostic.Evaluated);
        Assert.Equal(1, diagnostic.Skipped);
    }

    // The spec's 4-20mA line pinned at the top of its range, and the boundary it sits exactly on.
    [Fact]
    public void A_line_pinned_at_twenty_milliamps_fires_on_gte_and_not_on_gt()
    {
        var inclusive = new AlertEngineCore(Options);
        inclusive.SetRules([Rule("line", "plant/tank/level", new ThresholdCondition(ThresholdOp.Gte, 20.0))], Start);

        var exclusive = new AlertEngineCore(Options);
        exclusive.SetRules([Rule("line", "plant/tank/level", new ThresholdCondition(ThresholdOp.Gt, 20.0))], Start);

        Assert.Single(inclusive.OnMessage(Message("plant/tank/level", "20.0", Start), Start).Raised);
        Assert.Empty(exclusive.OnMessage(Message("plant/tank/level", "20.0", Start), Start).Raised);
        Assert.Equal(20.0, Assert.Single(inclusive.Snapshot().Active).Value);
    }

    [Fact]
    public void Two_rules_on_the_same_topic_keep_separate_alerts()
    {
        var engine = new AlertEngineCore(Options);
        engine.SetRules(
        [
            Rule("warn", "plant/#", new ThresholdCondition(ThresholdOp.Gt, 80), severity: AlertSeverity.Warn),
            Rule("critical", "plant/+/temp", Over90)
        ], Start);

        var outcome = engine.OnMessage(Message("plant/boiler/temp", "95", Start), Start);

        // Judged in the order they were saved, so a console that lists them lists them the same
        // way twice running.
        Assert.Equal(["warn", "critical"], outcome.Raised.Select(alert => alert.RuleId).ToArray());
        Assert.Equal(2, engine.Snapshot().Active.Count);
        Assert.All(engine.Snapshot().Rules, rule => Assert.Equal(1, rule.Topics));
    }

    [Fact]
    public void One_rule_across_two_topics_raises_one_alert_each()
    {
        var engine = new AlertEngineCore(Options);
        engine.SetRules([Rule("boiler", "plant/+/temp", Over90)], Start);

        engine.OnMessage(Message("plant/boiler/temp", "95", Start), Start);
        engine.OnMessage(Message("plant/kiln/temp", "99", Start), Start);

        var snapshot = engine.Snapshot();
        Assert.Equal(2, snapshot.Active.Count);
        Assert.Equal(["plant/boiler/temp", "plant/kiln/temp"],
            snapshot.Active.Select(alert => alert.Topic).Order().ToArray());
        // One rule, two pairs: the alarm belongs to the pair, so the kiln cooling does not close
        // the boiler's.
        Assert.Equal(2, Assert.Single(snapshot.Rules).Topics);
    }

    [Fact]
    public void Clearing_the_history_leaves_the_active_alert_alone()
    {
        var engine = new AlertEngineCore(Options);
        engine.SetRules([Rule("boiler", "plant/+/temp", Over90)], Start);
        engine.OnMessage(Message("plant/boiler/temp", "95", Start), Start);
        engine.OnMessage(Message("plant/boiler/temp", "85", Start.AddSeconds(1)), Start.AddSeconds(1));
        engine.OnTick(Start.AddSeconds(2), connected: true);
        engine.OnMessage(Message("plant/kiln/temp", "99", Start.AddSeconds(3)), Start.AddSeconds(3));

        engine.ClearHistory();

        var snapshot = engine.Snapshot();
        Assert.Empty(snapshot.History);
        // An open alarm is an unclosed promise, and tidying a list is not a reason to drop one.
        Assert.Equal("plant/kiln/temp", Assert.Single(snapshot.Active).Topic);
    }
}
