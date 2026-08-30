using MqttForge.Domain.Models;
using static MqttForge.UnitTests.Application.Alerts.AlertEngineFixture;

namespace MqttForge.UnitTests.Application.Alerts;

public class ClearAndCooldownTests
{
    [Fact]
    public void Without_Clear_the_alarm_goes_out_when_the_fire_condition_goes_false()
    {
        var core = Core(Rule(Above(90)));
        Assert.Single(core.OnMessage(Message("94.2", T0), T0).Raised);

        var cooler = core.OnMessage(Message("80", T0.AddSeconds(1)), T0.AddSeconds(1));

        // Not at the arrival. A late ring is a missed breach; a late resolve is only a late
        // resolve, and taking the decision on the tick is what caps a flapping pair.
        Assert.Empty(cooler.Resolved);
        Assert.Single(core.Snapshot().Active);

        var alert = Assert.Single(core.OnTick(T0.AddSeconds(2), connected: true).Resolved);
        Assert.Equal("clear", alert.ResolvedBy);
        Assert.Equal(T0.AddSeconds(2), alert.ResolvedAt);
        Assert.Equal("94.2 > 90", alert.Reason);     // the reason is why it rang, not why it stopped
        Assert.Empty(core.Snapshot().Active);
        Assert.Single(core.Snapshot().History);
    }

    [Fact]
    public void The_boiler_stays_in_alarm_between_the_two_thresholds()
    {
        // Fires above 90, clears below 85. 92, 87, 84.
        var core = Core(Rule(Above(90), clear: Below(85)));

        Assert.Single(core.OnMessage(Message("92", T0), T0).Raised);

        // 87 is under the fire threshold and over the clear one. Nothing happens, and that is the
        // whole of hysteresis: the alarm is not a live readout of the last message.
        Assert.Empty(core.OnMessage(Message("87", T0.AddSeconds(1)), T0.AddSeconds(1)).Raised);
        Assert.Empty(core.OnTick(T0.AddSeconds(2), connected: true).Resolved);
        Assert.Single(core.Snapshot().Active);

        core.OnMessage(Message("84", T0.AddSeconds(3)), T0.AddSeconds(3));
        var alert = Assert.Single(core.OnTick(T0.AddSeconds(4), connected: true).Resolved);

        Assert.Equal("clear", alert.ResolvedBy);
        Assert.Empty(core.Snapshot().Active);
    }

    [Fact]
    public void A_value_that_walks_the_gap_never_gets_out_of_alarm()
    {
        var core = Core(Rule(Above(90), clear: Below(85)));
        Assert.Single(core.OnMessage(Message("92", T0), T0).Raised);

        foreach (var (second, payload) in Enumerable.Range(1, 60)
                     .Select(s => (s, s % 2 == 0 ? "86" : "89.9")))
        {
            var at = T0.AddSeconds(second);
            core.OnMessage(Message(payload, at), at);
            Assert.Empty(core.OnTick(at, connected: true).Resolved);
        }

        var active = Assert.Single(core.Snapshot().Active);
        Assert.Equal(61, active.Count);           // still one alarm, sixty-one triggers
        Assert.Equal(T0.AddSeconds(60), active.LastSeenAt);
    }

    [Fact]
    public void Clear_is_not_evaluated_while_no_alarm_is_active()
    {
        // Clear is true from the first message and stays true for a minute. If it were judged
        // while the pair is quiet, its truth would land in the same TrueSince the fire edge uses
        // and the first hot message would ring at once instead of waiting its thirty seconds.
        var core = Core(Rule(Above(90), clear: Below(85), forSeconds: 30));

        for (var second = 0; second < 60; second++)
        {
            var at = T0.AddSeconds(second);
            Assert.Empty(core.OnMessage(Message("80", at), at).Raised);
            Assert.Empty(core.OnTick(at, connected: true).Raised);
        }

        var raised = new List<Alert>();
        for (var second = 60; second <= 95; second++)
        {
            var at = T0.AddSeconds(second);
            raised.AddRange(core.OnMessage(Message("92", at), at).Raised);
            raised.AddRange(core.OnTick(at, connected: true).Raised);
            if (second < 90) Assert.Empty(raised);
        }

        var alert = Assert.Single(raised);
        Assert.Equal(T0.AddSeconds(90), alert.FiredAt);
    }

    [Fact]
    public void Cooldown_holds_a_re_fire_back_and_lets_it_through_the_moment_it_lapses()
    {
        var core = Core(Rule(Above(90), cooldown: 10));

        Assert.Single(core.OnMessage(Message("92", T0), T0).Raised);
        core.OnMessage(Message("80", T0.AddSeconds(1)), T0.AddSeconds(1));
        Assert.Single(core.OnTick(T0.AddSeconds(2), connected: true).Resolved);

        // Hot again from T0+3, and judged all the way through: cooling is not blindness, it is
        // only silence.
        for (var second = 3; second < 12; second++)
        {
            var at = T0.AddSeconds(second);
            Assert.Empty(core.OnMessage(Message("92", at), at).Raised);
            Assert.Empty(core.OnTick(at, connected: true).Raised);
        }

        var at12 = T0.AddSeconds(12);
        var alert = Assert.Single(core.OnMessage(Message("92", at12), at12).Raised);
        Assert.Equal(at12, alert.FiredAt);
    }

    [Fact]
    public void Cooldown_defaults_to_one_second_rather_than_none()
    {
        var core = Core(Rule(Above(90)));      // Cooldown null

        Assert.Single(core.OnMessage(Message("92", T0), T0).Raised);
        core.OnMessage(Message("80", T0.AddSeconds(1)), T0.AddSeconds(1));
        Assert.Single(core.OnTick(T0.AddSeconds(2), connected: true).Resolved);

        var early = T0.AddSeconds(2).AddMilliseconds(500);
        Assert.Empty(core.OnMessage(Message("92", early), early).Raised);

        var lapsed = T0.AddSeconds(3);
        Assert.Single(core.OnMessage(Message("92", lapsed), lapsed).Raised);
    }

    [Fact]
    public void A_flapping_signal_changes_state_at_most_once_a_second()
    {
        // 89.9 and 90.1, alternating, fifty messages a simulated second, for ten seconds.
        var core = Core(Rule(Above(90)));
        var raised = 0;
        var resolved = 0;

        for (var second = 0; second < 10; second++)
        {
            for (var i = 0; i < 50; i++)
            {
                var at = T0.AddSeconds(second).AddMilliseconds(i * 20);
                var outcome = core.OnMessage(Message(i % 2 == 0 ? "90.1" : "89.9", at), at);
                raised += outcome.Raised.Count;
                resolved += outcome.Resolved.Count;
            }

            var tick = core.OnTick(T0.AddSeconds(second + 1), connected: true);
            raised += tick.Raised.Count;
            resolved += tick.Resolved.Count;
        }

        // Five hundred messages, ten state changes: one a second, which is the ceiling the tick
        // and the one-second Cooldown exist to hold. With Cooldown at zero the same stream rings
        // and clears every second — twice this — and with resolving done at arrivals as well it
        // is roughly twenty-five pairs a second, which empties a five-hundred-deep history in
        // twenty seconds and a thousand-deep webhook queue in forty.
        Assert.Equal(5, raised);
        Assert.Equal(5, resolved);
        Assert.True(raised + resolved <= 10);
    }

    [Fact]
    public void An_alarm_that_is_already_ringing_does_not_multiply()
    {
        var core = Core(Rule(Above(90)));
        var raised = new List<Alert>();

        for (var i = 0; i < 50; i++)
        {
            var at = T0.AddMilliseconds(i * 20);
            raised.AddRange(core.OnMessage(Message("94.2", at), at).Raised);
        }

        Assert.Single(raised);
        var active = Assert.Single(core.Snapshot().Active);
        Assert.Equal(50, active.Count);
        Assert.Equal(T0, active.FiredAt);
        Assert.Equal(T0.AddMilliseconds(980), active.LastSeenAt);
    }

    [Fact]
    public void A_resolved_alarm_goes_to_the_history_newest_first()
    {
        var core = Core(Rule(Above(90), cooldown: 0));

        for (var round = 0; round < 3; round++)
        {
            var hot = T0.AddSeconds(round * 10);
            core.OnMessage(Message("92", hot), hot);
            core.OnMessage(Message("80", hot.AddSeconds(1)), hot.AddSeconds(1));
            core.OnTick(hot.AddSeconds(2), connected: true);
        }

        var history = core.Snapshot().History;
        Assert.Equal(3, history.Count);
        Assert.Equal(T0.AddSeconds(22), history[0].ResolvedAt);
        Assert.Equal(T0.AddSeconds(2), history[2].ResolvedAt);
    }
}
