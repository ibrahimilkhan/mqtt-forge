using MqttForge.Domain.Models;
using static MqttForge.UnitTests.Application.Alerts.AlertEngineFixture;

namespace MqttForge.UnitTests.Application.Alerts;

public class SilenceAndConnectionTests
{
    private static SilenceCondition QuietFor(int seconds) => new(seconds);

    [Fact]
    public void A_topic_that_goes_quiet_rings_on_the_tick()
    {
        var core = Core(Rule(QuietFor(60)));
        core.OnTick(T0, connected: true);

        var spoke = T0.AddSeconds(1);
        core.OnMessage(Message("20.1", spoke), spoke);

        for (var second = 2; second < 61; second++)
            Assert.Empty(core.OnTick(T0.AddSeconds(second), connected: true).Raised);

        var alert = Assert.Single(core.OnTick(T0.AddSeconds(61), connected: true).Raised);
        Assert.Equal("no message for 60s", alert.Reason);
        Assert.Equal(Topic, alert.Topic);
        Assert.Null(alert.Value);
        Assert.Null(alert.Sample);
    }

    [Fact]
    public void A_topic_that_keeps_arriving_says_nothing()
    {
        var core = Core(Rule(QuietFor(60)));
        core.OnTick(T0, connected: true);

        for (var second = 1; second <= 600; second++)
        {
            var at = T0.AddSeconds(second);
            if (second % 10 == 0)
                Assert.Empty(core.OnMessage(Message("20.1", at), at).Raised);
            Assert.Empty(core.OnTick(at, connected: true).Raised);
        }
    }

    [Fact]
    public void A_filter_that_names_one_topic_rings_though_the_topic_was_never_seen()
    {
        // 'This device has never spoken' is the most-wanted alert of the lot, and a filter with
        // no wildcard is not really a filter — it is the topic's own name, so the engine can
        // check it without ever having heard from it.
        var core = Core(Rule(QuietFor(60), filter: "plant/boiler/temp"));
        core.OnTick(T0, connected: true);

        for (var second = 1; second < 60; second++)
            Assert.Empty(core.OnTick(T0.AddSeconds(second), connected: true).Raised);

        var alert = Assert.Single(core.OnTick(T0.AddSeconds(60), connected: true).Raised);
        Assert.Equal("plant/boiler/temp", alert.Topic);
        Assert.Equal("no message for 60s", alert.Reason);
    }

    [Fact]
    public void A_wildcard_silence_rule_says_nothing_about_a_topic_it_has_never_heard()
    {
        // With a '+' the engine has no idea which sensors are supposed to exist, and this tool
        // keeps no inventory. It can only miss what it has met.
        var core = Core(Rule(QuietFor(60), filter: "plant/+/temp"));
        core.OnTick(T0, connected: true);

        for (var second = 1; second <= 3600; second++)
            Assert.Empty(core.OnTick(T0.AddSeconds(second), connected: true).Raised);

        // One message is all it takes to be watched from then on.
        var spoke = T0.AddSeconds(3601);
        core.OnMessage(Message("20.1", spoke, "plant/boiler/temp"), spoke);

        for (var second = 3602; second < 3661; second++)
            Assert.Empty(core.OnTick(T0.AddSeconds(second), connected: true).Raised);

        var alert = Assert.Single(core.OnTick(T0.AddSeconds(3661), connected: true).Raised);
        Assert.Equal("plant/boiler/temp", alert.Topic);
    }

    [Fact]
    public void The_silence_alarm_goes_out_on_the_tick_after_the_topic_speaks_again()
    {
        var core = Core(Rule(QuietFor(60)));
        core.OnTick(T0, connected: true);
        Assert.Single(core.OnTick(T0.AddSeconds(60), connected: true).Raised);

        var spoke = T0.AddSeconds(70);
        var arrival = core.OnMessage(Message("20.1", spoke), spoke);

        // Resolving stays the tick's, here as everywhere.
        Assert.Empty(arrival.Resolved);
        Assert.Single(core.Snapshot().Active);

        var alert = Assert.Single(core.OnTick(T0.AddSeconds(71), connected: true).Resolved);
        Assert.Equal("clear", alert.ResolvedBy);
        Assert.Empty(core.Snapshot().Active);
    }

    [Fact]
    public void A_blind_tick_judges_no_silence()
    {
        var core = Core(Rule(QuietFor(60)));
        core.OnTick(T0, connected: true);

        var spoke = T0.AddSeconds(1);
        core.OnMessage(Message("20.1", spoke), spoke);

        // An hour with the link down. Every second of it is past the sixty, and not one rings.
        for (var second = 2; second <= 3600; second++)
        {
            var outcome = core.OnTick(T0.AddSeconds(second), connected: false);
            Assert.Empty(outcome.Raised);
            Assert.Empty(outcome.Resolved);
        }

        // The link comes back and the clock starts again from there, not from an hour ago.
        var back = T0.AddSeconds(3601);
        Assert.Empty(core.OnTick(back, connected: true).Raised);
        for (var second = 1; second < 60; second++)
            Assert.Empty(core.OnTick(back.AddSeconds(second), connected: true).Raised);

        Assert.Single(core.OnTick(back.AddSeconds(60), connected: true).Raised);
    }

    [Fact]
    public void A_blind_tick_matures_no_For()
    {
        var core = Core(Rule(Above(90), forSeconds: 30));
        core.OnTick(T0, connected: true);
        Assert.Empty(core.OnMessage(Message("94.2", T0), T0).Raised);

        for (var second = 1; second <= 120; second++)
            Assert.Empty(core.OnTick(T0.AddSeconds(second), connected: false).Raised);

        // Back on the link: the half-finished For does not complete either, because the seconds
        // it counted are seconds nobody watched.
        var back = T0.AddSeconds(121);
        Assert.Empty(core.OnTick(back, connected: true).Raised);
        for (var second = 1; second <= 60; second++)
            Assert.Empty(core.OnTick(back.AddSeconds(second), connected: true).Raised);

        // A real message starts a real thirty seconds.
        var hot = back.AddSeconds(61);
        Assert.Empty(core.OnMessage(Message("94.2", hot), hot).Raised);
        for (var second = 1; second < 30; second++)
            Assert.Empty(core.OnTick(hot.AddSeconds(second), connected: true).Raised);

        var alert = Assert.Single(core.OnTick(hot.AddSeconds(30), connected: true).Raised);
        Assert.Equal(hot.AddSeconds(30), alert.FiredAt);
    }

    [Fact]
    public void A_five_minute_outage_across_a_hundred_topics_rings_nothing()
    {
        var core = Core(Rule(QuietFor(60), filter: "plant/+/temp"));
        core.OnTick(T0, connected: true);

        var topics = Enumerable.Range(0, 100).Select(i => $"plant/{i}/temp").ToArray();
        var spoke = T0.AddSeconds(1);
        foreach (var topic in topics)
            core.OnMessage(Message("20.1", spoke, topic), spoke);

        for (var second = 2; second <= 30; second++)
            Assert.Empty(core.OnTick(T0.AddSeconds(second), connected: true).Raised);

        // Five minutes of nothing. One event, and it is already reported on its own — a hundred
        // topics that are quiet because nothing can reach them are not a hundred faults.
        for (var second = 31; second <= 330; second++)
        {
            var outcome = core.OnTick(T0.AddSeconds(second), connected: false);
            Assert.Empty(outcome.Raised);
            Assert.Empty(outcome.Resolved);
        }

        var back = T0.AddSeconds(331);
        Assert.Empty(core.OnTick(back, connected: true).Raised);
        for (var second = 1; second < 60; second++)
            Assert.Empty(core.OnTick(back.AddSeconds(second), connected: true).Raised);

        // And the engine is not merely dead: sixty quiet seconds after the link returned, all
        // hundred ring exactly once.
        Assert.Equal(100, core.OnTick(back.AddSeconds(60), connected: true).Raised.Count);
    }

    [Fact]
    public void An_outage_does_not_put_out_an_alarm_that_is_already_ringing()
    {
        var core = Core(Rule(Above(90)));
        core.OnTick(T0, connected: true);
        Assert.Single(core.OnMessage(Message("94.2", T0), T0).Raised);

        for (var second = 1; second <= 300; second++)
            Assert.Empty(core.OnTick(T0.AddSeconds(second), connected: false).Resolved);

        // Windows, active alarms, mutes and cooldowns all survive a blink. Only a different
        // broker throws them away, and that is the rule set's reconciliation, not this.
        Assert.Single(core.Snapshot().Active);
    }
}
