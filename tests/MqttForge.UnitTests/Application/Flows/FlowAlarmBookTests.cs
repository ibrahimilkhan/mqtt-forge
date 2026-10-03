using MqttForge.Application.Flows;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using AlertEvent = MqttForge.Application.Alerts.AlertEvent;

namespace MqttForge.UnitTests.Application.Flows;

public class FlowAlarmBookTests
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 3, 9, 0, 0, TimeSpan.Zero);
    private static readonly IReadOnlyDictionary<string, string> Variables = new Dictionary<string, string> { ["site"] = "north" };
    private static readonly FlowRunKey Active = new("f1", FlowRunKind.Active);
    private static readonly FlowRunKey Test = new("f1", FlowRunKind.Test);

    private readonly FlowAlarmBook _book = new();

    private static CompiledFlow Flow(string level = "critical", string name = "Boiler watch", string alarm = "Hot", string id = "f1") =>
        new ChartBuilder(id, name).Var("site", "north")
            .Node("start", "start")
            .Node("hot", "alarmRaise", new { name = alarm, level, reason = "{{var.site}} {{topic[1]}} at {{$.temp}}", value = "$.temp" })
            .Node("end", "end")
            .Then("start", "hot").Wire("hot", "raised", "end").Wire("hot", "up", "end")
            .Compile();

    private static AlarmRaiseNode Hot(CompiledFlow flow) => (AlarmRaiseNode)flow.Nodes["hot"];

    private static FlowMessage Reading(string topic = "plant/k1/temp", double temp = 94.2) =>
        new(topic, $"{{\"temp\":{temp.ToString(System.Globalization.CultureInfo.InvariantCulture)}}}", 0);

    private (Alert? Alert, bool IsNew) Raise(
        FlowRunKind kind = FlowRunKind.Active, FlowMessage? message = null, CompiledFlow? flow = null, DateTimeOffset? at = null)
    {
        var compiled = flow ?? Flow();
        return _book.Raise(compiled, kind, Hot(compiled), message ?? Reading(), Variables, at ?? T0, new Random(7));
    }

    [Fact]
    public void A_raise_opens_an_alarm_the_alerts_panel_can_show()
    {
        var (alert, isNew) = Raise();

        Assert.True(isNew);
        Assert.NotNull(alert);
        Assert.Equal("flow-f1-hot", alert.RuleId);
        Assert.Equal("Boiler watch · Hot", alert.RuleName);
        Assert.Equal("plant/k1/temp", alert.Topic);
        Assert.Equal(AlertSeverity.Critical, alert.Severity);
        Assert.Equal("north k1 at 94.2", alert.Reason);
        Assert.Equal(94.2, alert.Value);
        Assert.Equal("{\"temp\":94.2}", alert.Sample);
        Assert.Equal(1, alert.Count);
        Assert.Equal([new ScreenAction()], alert.Actions);
        Assert.Equal([alert], _book.Active());
    }

    [Fact]
    public void A_second_raise_on_the_topic_counts_it_and_is_not_new()
    {
        Raise();
        var (alert, isNew) = _book.Raise(Flow(), FlowRunKind.Active, Hot(Flow()), Reading(), Variables, T0.AddSeconds(5), new Random(7));

        Assert.False(isNew);
        Assert.Equal(2, alert!.Count);
        Assert.Equal(T0.AddSeconds(5), alert.LastSeenAt);
        Assert.Single(_book.Active());
    }

    [Fact]
    public void Each_topic_has_an_alarm_of_its_own()
    {
        Raise(message: Reading("plant/k1/temp"));
        Raise(message: Reading("plant/k2/temp"));

        Assert.Equal(2, _book.Active().Count);
    }

    [Fact]
    public void A_tests_alarms_are_its_own()
    {
        Raise();
        var (test, isNew) = Raise(FlowRunKind.Test);

        Assert.True(isNew);
        Assert.Equal("flowtest-f1-hot", test!.RuleId);
        Assert.Equal("Boiler watch · Hot (test)", test.RuleName);

        var ended = _book.ResolveRun(Test, FlowAlarmBook.TestEnded, T0);

        Assert.Equal("test ended", Assert.Single(ended).ResolvedBy);
        Assert.Equal("flow-f1-hot", Assert.Single(_book.Active()).RuleId);
    }

    [Fact]
    public void A_clear_ends_the_alarm_of_its_topic_and_only_that()
    {
        Raise(message: Reading("plant/k1/temp"));
        Raise(message: Reading("plant/k2/temp"));

        var cleared = _book.Clear(Active, "hot", "plant/k1/temp", T0.AddSeconds(9));

        Assert.Equal("clear", cleared!.ResolvedBy);
        Assert.Equal(T0.AddSeconds(9), cleared.ResolvedAt);
        Assert.Equal(["plant/k2/temp"], _book.Active().Select(alert => alert.Topic));
        Assert.Equal([cleared], _book.History());
        Assert.Null(_book.Clear(Active, "hot", "plant/k1/temp", T0));
        Assert.Null(_book.Clear(Test, "hot", "plant/k2/temp", T0));
    }

    [Fact]
    public void An_update_keeps_an_alarm_that_still_means_what_it_meant()
    {
        Raise();

        Assert.Empty(_book.Reconcile(Flow(), Flow(), T0));
        Assert.Equal("flow changed", Assert.Single(_book.Reconcile(Flow(), Flow(level: "warn"), T0)).ResolvedBy);
    }

    [Fact]
    public void Renaming_the_flow_ends_its_alarms_on_an_update()
    {
        Raise();

        Assert.Single(_book.Reconcile(Flow(), Flow(name: "Kiln watch"), T0));
    }

    [Fact]
    public void A_link_that_ended_ends_every_alarm()
    {
        Raise();
        Raise(FlowRunKind.Test);

        Assert.All(_book.ResolveAll(FlowAlarmBook.ConnectionEnded, T0), alert => Assert.Equal("connection ended", alert.ResolvedBy));
        Assert.Empty(_book.Active());
    }

    [Fact]
    public void Standing_alarms_are_listed_under_their_run_and_node()
    {
        Raise();
        Raise(FlowRunKind.Test, Reading("plant/k2/temp"));

        var standing = _book.StandingByNode(20);

        Assert.Equal("plant/k1/temp", Assert.Single(standing[(Active, "hot")]).Topic);
        Assert.Equal("plant/k2/temp", Assert.Single(standing[(Test, "hot")]).Topic);
    }

    [Fact]
    public void Past_the_ceiling_no_new_alarm_is_raised()
    {
        for (var i = 0; i < FlowLimits.StandingAlarms; i++) Raise(message: Reading($"plant/{i}/temp"));

        var (alert, isNew) = Raise(message: Reading("plant/one-more/temp"));

        Assert.Null(alert);
        Assert.False(isNew);
    }

    [Fact]
    public void The_outcomes_of_several_calls_go_one_after_another()
    {
        var publish = new FlowPublish(Active, "pub", new PublishRequest("a/b", [], 0, false));
        var sound = new FlowSound("f1", "beep", AlertSeverity.Warn, Test: false);

        var merged = FlowOutcome.Merge([
            FlowOutcome.Empty,
            FlowOutcome.Empty with { Publishes = [publish] },
            FlowOutcome.Empty with { Sounds = [sound] },
        ]);

        Assert.Equal([publish], merged.Publishes);
        Assert.Equal([sound], merged.Sounds);
        Assert.False(merged.IsEmpty);
        Assert.True(FlowOutcome.Merge([FlowOutcome.Empty]).IsEmpty);
    }

    [Fact]
    public void At_the_ceiling_an_alarm_that_is_up_goes_on_counting_and_a_clear_gives_a_place_back()
    {
        for (var i = 0; i < FlowLimits.StandingAlarms; i++) Raise(message: Reading($"plant/{i}/temp"));

        var (counted, countedIsNew) = Raise(message: Reading("plant/0/temp"));

        Assert.False(countedIsNew);
        Assert.Equal(2, counted!.Count);

        _book.Clear(Active, "hot", "plant/1/temp", T0);
        var (placed, placedIsNew) = Raise(message: Reading("plant/one-more/temp"));

        Assert.True(placedIsNew);
        Assert.NotNull(placed);
    }

    [Fact]
    public void An_alarms_reason_and_sample_are_cut_to_the_length_an_alarm_keeps()
    {
        var payload = $"{{\"temp\":\"{new string('x', FlowLimits.SampleLength)}\"}}";

        var (alert, _) = Raise(message: new FlowMessage("plant/k1/temp", payload));

        Assert.Equal(FlowLimits.ReasonLength, alert!.Reason.Length);
        Assert.Equal(FlowLimits.SampleLength, alert.Sample!.Length);
    }

    [Fact]
    public void An_alarms_value_can_be_read_from_a_variable()
    {
        var flow = new ChartBuilder("f1", "Boiler watch").Var("limit", "0")
            .Node("start", "start")
            .Node("hot", "alarmRaise", new { name = "Hot", level = "warn", value = "var.limit" })
            .Node("end", "end")
            .Then("start", "hot").Wire("hot", "raised", "end").Wire("hot", "up", "end")
            .Compile();
        var variables = new Dictionary<string, string> { ["limit"] = "7.5" };

        var (alert, _) = _book.Raise(flow, FlowRunKind.Active, Hot(flow), Reading(), variables, T0, new Random(7));

        Assert.Equal(7.5, alert!.Value);
    }

    [Fact]
    public void The_alarms_that_are_up_are_listed_oldest_first()
    {
        Raise(message: Reading("plant/k2/temp"), at: T0.AddSeconds(2));
        Raise(message: Reading("plant/k1/temp"), at: T0.AddSeconds(1));

        Assert.Equal(["plant/k1/temp", "plant/k2/temp"], _book.Active().Select(alert => alert.Topic));
    }

    [Fact]
    public void The_history_keeps_the_newest_hundred_newest_first()
    {
        for (var i = 0; i < FlowLimits.AlarmHistory + 10; i++)
        {
            Raise();
            _book.Clear(Active, "hot", "plant/k1/temp", T0.AddSeconds(i));
        }

        var history = _book.History();

        Assert.Equal(FlowLimits.AlarmHistory, history.Count);
        Assert.Equal(T0.AddSeconds(FlowLimits.AlarmHistory + 9), history[0].ResolvedAt);
        Assert.Equal(T0.AddSeconds(10), history[^1].ResolvedAt);
    }

    [Fact]
    public void Clearing_the_history_empties_it_and_leaves_what_is_standing()
    {
        Raise(message: Reading("plant/k1/temp"));
        Raise(message: Reading("plant/k2/temp"));
        _book.Clear(Active, "hot", "plant/k1/temp", T0.AddSeconds(1));

        _book.ClearHistory();

        Assert.Empty(_book.History());
        Assert.Equal(["plant/k2/temp"], _book.Active().Select(alert => alert.Topic));
    }

    [Fact]
    public void An_update_ends_the_alarms_of_that_flows_active_run_and_no_others()
    {
        Raise();
        Raise(FlowRunKind.Test, at: T0.AddSeconds(1));
        Raise(flow: Flow(id: "f2"), at: T0.AddSeconds(2));

        var ended = _book.Reconcile(Flow(), Flow(level: "warn"), T0);

        Assert.Equal(["flow-f1-hot"], ended.Select(alert => alert.RuleId));
        Assert.Equal(["flowtest-f1-hot", "flow-f2-hot"], _book.Active().Select(alert => alert.RuleId));
    }

    [Fact]
    public void Renaming_the_alarm_ends_it_on_an_update()
    {
        Raise();

        Assert.Equal("flow changed", Assert.Single(_book.Reconcile(Flow(), Flow(alarm: "Too hot"), T0)).ResolvedBy);
    }

    [Fact]
    public void Taking_the_raise_alarm_node_away_ends_its_alarms_on_an_update()
    {
        Raise();
        var without = new ChartBuilder("f1", "Boiler watch").Node("start", "start").Node("end", "end").Then("start", "end").Compile();

        Assert.Equal("flow changed", Assert.Single(_book.Reconcile(Flow(), without, T0)).ResolvedBy);
    }

    [Fact]
    public void A_nodes_standing_alarms_are_oldest_first_and_no_more_than_asked_for()
    {
        Raise(message: Reading("plant/k3/temp"), at: T0.AddSeconds(3));
        Raise(message: Reading("plant/k1/temp"), at: T0.AddSeconds(1));
        Raise(message: Reading("plant/k2/temp"), at: T0.AddSeconds(2));
        Raise(message: Reading("plant/k1/temp"), at: T0.AddSeconds(4));

        Assert.Equal(
            [new FlowStanding("plant/k1/temp", T0.AddSeconds(1), "north k1 at 94.2", 2),
             new FlowStanding("plant/k2/temp", T0.AddSeconds(2), "north k2 at 94.2", 1)],
            _book.StandingByNode(2)[(Active, "hot")]);
    }

    // Why an alarm went away is its ResolvedBy, which reaches the console and the log as these exact
    // words: they are part of what this book produces, so a reworded one is a change to the product.
    [Theory]
    [InlineData(FlowAlarmBook.Cleared, "clear")]
    [InlineData(FlowAlarmBook.FlowChanged, "flow changed")]
    [InlineData(FlowAlarmBook.FlowOff, "flow off")]
    [InlineData(FlowAlarmBook.FlowRemoved, "flow removed")]
    [InlineData(FlowAlarmBook.TestEnded, "test ended")]
    [InlineData(FlowAlarmBook.ConnectionEnded, "connection ended")]
    public void An_alarm_ends_for_a_reason_in_these_exact_words(string reason, string words) =>
        Assert.Equal(words, reason);

    private FlowOutcome OutcomeOf(string node) => new(
        [new FlowPublish(Active, node, new PublishRequest("a/b", [], 0, false))],
        [new AlertEvent(Raise(message: Reading($"plant/{node}/temp")).Alert!, Raised: true)],
        [new FlowDebugEntry("f1", node, T0, FlowDebugEntry.Message, "a/b", "hot", Test: false)],
        [new FlowSound("f1", node, AlertSeverity.Info, Test: false)],
        [new FlowNotice("f1", "Boiler watch", node, "hot", AlertSeverity.Info, T0, Test: false)],
        [new FlowWebhookPost(Active, node, "https://example.com/hook", "{}", "application/json")]);

    [Fact]
    public void Every_kind_of_outcome_is_merged_in_the_order_of_the_calls()
    {
        var merged = FlowOutcome.Merge([OutcomeOf("one"), FlowOutcome.Empty, OutcomeOf("two")]);

        Assert.Equal(["one", "two"], merged.Publishes.Select(publish => publish.NodeId));
        Assert.Equal(["plant/one/temp", "plant/two/temp"], merged.Alarms.Select(alarm => alarm.Alert.Topic));
        Assert.Equal(["one", "two"], merged.Debug.Select(line => line.NodeId));
        Assert.Equal(["one", "two"], merged.Sounds.Select(sound => sound.NodeId));
        Assert.Equal(["one", "two"], merged.Notices.Select(notice => notice.NodeId));
        Assert.Equal(["one", "two"], merged.Webhooks.Select(post => post.NodeId));
    }

    [Fact]
    public void An_outcome_with_any_one_kind_of_thing_in_it_is_not_empty()
    {
        var all = OutcomeOf("one");

        FlowOutcome[] each =
        [
            FlowOutcome.Empty with { Publishes = all.Publishes },
            FlowOutcome.Empty with { Alarms = all.Alarms },
            FlowOutcome.Empty with { Debug = all.Debug },
            FlowOutcome.Empty with { Sounds = all.Sounds },
            FlowOutcome.Empty with { Notices = all.Notices },
            FlowOutcome.Empty with { Webhooks = all.Webhooks },
        ];

        Assert.All(each, outcome => Assert.False(outcome.IsEmpty));
    }
}
