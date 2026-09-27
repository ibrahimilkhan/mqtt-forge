using MqttForge.Application.Flows;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Flows;

// What happens to a standing flow alarm when something other than its own flow's messages moves:
// the link, a redeploy, a flow turned off or taken away.
public class FlowAlarmTests
{
    private static readonly DateTimeOffset T0 = new(2026, 9, 26, 9, 0, 0, TimeSpan.Zero);

    private readonly FlowRuntime _runtime = new(new Random(7));

    private static FlowBuilder Watch(string name = "Boiler watch", string alarm = "Hot",
        string severity = "critical", string fan = "on") =>
        new FlowBuilder(name: name)
            .Node("in", "mqttIn", new { filter = "plant/+/temp" })
            .Node("test", "if", new { field = "$.temp", test = "gt", value = "90" })
            .Node("hot", "alarm", new { name = alarm, severity })
            .Node("fan", "publish", new { topic = "plant/{{topic[1]}}/cmd", payload = fan })
            .Wire("in", "out", "test", "in")
            .Wire("test", "yes", "hot", "raise")
            .Wire("test", "yes", "fan", "in")
            .Wire("test", "no", "hot", "clear");

    private void Ringing(CompiledFlow flow)
    {
        _runtime.Deploy([flow], [flow.Id], T0);
        _runtime.OnTick(T0, connected: true);
        _runtime.OnMessage(new MqttMessage("plant/k1/temp", "{\"temp\":95}", "text", 0, false, T0), T0);
        Assert.Single(_runtime.Alarms().Active);
    }

    [Fact]
    public void A_link_that_drops_resolves_every_standing_alarm()
    {
        Ringing(Watch().Compile());

        var outcome = _runtime.OnTick(T0.AddSeconds(1), connected: false);

        Assert.Equal("connection ended", Assert.Single(outcome.Resolved).ResolvedBy);
        Assert.Empty(_runtime.Alarms().Active);
        Assert.Single(_runtime.Alarms().History);
    }

    // A live link that went to another broker between two looks: its alarms end as a dropped link's
    // do, and nothing else happens. What came due is the next tick's, and the link is still up for it.
    [Fact]
    public void A_move_to_another_broker_resolves_every_standing_alarm_and_runs_nothing_that_is_due()
    {
        var ticker = new FlowBuilder("f2", "Simulator")
            .Node("tick", "every", new { seconds = 1, topic = "plant/sim/ping", payload = "on" })
            .Node("send", "publish", new { topic = "{{topic}}", payload = "{{payload}}" })
            .Wire("tick", "out", "send", "in")
            .Compile();
        _runtime.Deploy([Watch().Compile(), ticker], ["f1", "f2"], T0);
        _runtime.OnTick(T0, connected: true);
        _runtime.OnMessage(new MqttMessage("plant/k1/temp", "{\"temp\":95}", "text", 0, false, T0), T0);

        var moved = _runtime.OnMove(T0.AddSeconds(1));

        Assert.Equal("connection ended", Assert.Single(moved.Resolved).ResolvedBy);
        Assert.Empty(moved.Publishes);
        Assert.Empty(_runtime.Alarms().Active);
        Assert.Equal(["plant/sim/ping"],
            _runtime.OnTick(T0.AddSeconds(1), connected: true).Publishes.Select(publish => publish.Request.Topic));
    }

    [Fact]
    public void Turning_a_flow_off_resolves_its_alarms_as_flow_off()
    {
        Ringing(Watch().Compile());

        var outcome = _runtime.Deploy([Watch().Off().Compile()], ["f1"], T0.AddSeconds(1));

        Assert.Equal("flow off", Assert.Single(outcome.Resolved).ResolvedBy);
        Assert.Empty(_runtime.Status().Flows);
    }

    [Fact]
    public void Removing_a_flow_resolves_its_alarms_as_flow_removed()
    {
        Ringing(Watch().Compile());

        var outcome = _runtime.Deploy([], [], T0.AddSeconds(1));

        Assert.Equal("flow removed", Assert.Single(outcome.Resolved).ResolvedBy);
    }

    [Fact]
    public void Redeploying_an_unchanged_flow_keeps_everything()
    {
        Ringing(Watch().Compile());

        var outcome = _runtime.Deploy([Watch().Compile()], ["f1"], T0.AddSeconds(1));

        Assert.True(outcome.IsEmpty);
        Assert.Single(_runtime.Alarms().Active);
        Assert.Equal(1, _runtime.Status().Flows.Single().Nodes.Single(node => node.Id == "in").Count);
    }

    [Theory]
    [InlineData("Boiler house", "Hot", "critical")]
    [InlineData("Boiler watch", "Too hot", "critical")]
    [InlineData("Boiler watch", "Hot", "warn")]
    public void Changing_the_flows_name_or_the_alarms_name_or_level_resolves_it_as_flow_changed(
        string name, string alarm, string severity)
    {
        Ringing(Watch().Compile());

        var outcome = _runtime.Deploy([Watch(name, alarm, severity).Compile()], ["f1"], T0.AddSeconds(1));

        Assert.Equal("flow changed", Assert.Single(outcome.Resolved).ResolvedBy);
    }

    [Fact]
    public void Changing_another_node_keeps_the_alarm_standing()
    {
        Ringing(Watch().Compile());

        var outcome = _runtime.Deploy([Watch(fan: "{\"fan\":\"max\"}").Compile()], ["f1"], T0.AddSeconds(1));

        Assert.Empty(outcome.Resolved);
        Assert.Single(_runtime.Alarms().Active);
    }

    [Fact]
    public void Taking_the_alarm_node_away_resolves_its_alarms_as_flow_changed()
    {
        Ringing(Watch().Compile());

        var withoutIt = new FlowBuilder()
            .Node("in", "mqttIn", new { filter = "plant/+/temp" })
            .Node("test", "if", new { field = "$.temp", test = "gt", value = "90" })
            .Wire("in", "out", "test", "in")
            .Compile();

        var outcome = _runtime.Deploy([withoutIt], ["f1"], T0.AddSeconds(1));

        Assert.Equal("flow changed", Assert.Single(outcome.Resolved).ResolvedBy);
        Assert.Empty(_runtime.Alarms().Active);
    }

    [Fact]
    public void Clearing_the_history_empties_it_and_leaves_what_is_standing()
    {
        Ringing(Watch().Compile());
        _runtime.OnMessage(new MqttMessage("plant/k1/temp", "{\"temp\":50}", "text", 0, false, T0), T0.AddSeconds(1));
        _runtime.OnMessage(new MqttMessage("plant/k2/temp", "{\"temp\":95}", "text", 0, false, T0), T0.AddSeconds(2));
        var before = _runtime.Version;

        _runtime.ClearHistory();

        Assert.Empty(_runtime.Alarms().History);
        Assert.Equal("plant/k2/temp", Assert.Single(_runtime.Alarms().Active).Topic);
        Assert.True(_runtime.Version > before);
    }

    [Fact]
    public void History_keeps_the_newest_hundred()
    {
        _runtime.Deploy([Watch().Compile()], ["f1"], T0);
        _runtime.OnTick(T0, connected: true);

        for (var i = 0; i < FlowLimits.AlarmHistory + 10; i++)
        {
            _runtime.OnMessage(new MqttMessage("plant/k1/temp", "{\"temp\":95}", "text", 0, false, T0), T0.AddSeconds(i));
            _runtime.OnMessage(new MqttMessage("plant/k1/temp", "{\"temp\":50}", "text", 0, false, T0), T0.AddSeconds(i));
        }

        var history = _runtime.Alarms().History;
        Assert.Equal(FlowLimits.AlarmHistory, history.Count);
        Assert.Equal(T0.AddSeconds(FlowLimits.AlarmHistory + 9), history[0].ResolvedAt);
    }
}
