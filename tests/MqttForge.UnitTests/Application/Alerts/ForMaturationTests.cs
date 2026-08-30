using MqttForge.Domain.Models;
using static MqttForge.UnitTests.Application.Alerts.AlertEngineFixture;

namespace MqttForge.UnitTests.Application.Alerts;

public class ForMaturationTests
{
    [Fact]
    public void A_rule_without_For_rings_on_the_arrival_that_makes_it_true()
    {
        var core = Core(Rule(Above(90)));

        var outcome = core.OnMessage(Message("94.2", T0), T0);

        var alert = Assert.Single(outcome.Raised);
        Assert.Equal(T0, alert.FiredAt);
        Assert.Equal("94.2 > 90", alert.Reason);
        Assert.Equal(94.2, alert.Value);
        Assert.Equal("94.2", alert.Sample);
    }

    [Fact]
    public void For_does_not_ring_before_its_seconds_have_passed()
    {
        var core = Core(Rule(Above(90), forSeconds: 30));

        Assert.Empty(core.OnMessage(Message("94.2", T0), T0).Raised);

        for (var second = 1; second < 30; second++)
        {
            var at = T0.AddSeconds(second);
            Assert.Empty(core.OnMessage(Message("94.2", at), at).Raised);
            Assert.Empty(core.OnTick(at, connected: true).Raised);
        }

        Assert.Empty(core.Snapshot().Active);
    }

    [Fact]
    public void For_rings_exactly_once_when_the_condition_stays_true_across_maturity()
    {
        var core = Core(Rule(Above(90), forSeconds: 30));
        var raised = new List<Alert>();

        for (var second = 0; second <= 40; second++)
        {
            var at = T0.AddSeconds(second);
            raised.AddRange(core.OnMessage(Message("94.2", at), at).Raised);
            raised.AddRange(core.OnTick(at, connected: true).Raised);
        }

        var alert = Assert.Single(raised);

        // The moment maturity completed, not the moment the condition first went true. Thirty
        // seconds of quiet waiting is what the rule asked for; stamping the alert at T0 would
        // tell the endpoint it had been ignored for half a minute.
        Assert.Equal(T0.AddSeconds(30), alert.FiredAt);
        Assert.NotEqual(T0, alert.FiredAt);
        Assert.Equal("94.2 > 90 for 30s", alert.Reason);
        Assert.Single(core.Snapshot().Active);
    }

    [Fact]
    public void Maturity_completed_on_a_tick_rings_from_the_tick_and_quotes_no_body()
    {
        var core = Core(Rule(Above(90), forSeconds: 25));

        // Three arrivals ten seconds apart, then nothing but ticks. The last real judgement is
        // at T0+20, five seconds before maturity — comfortably inside the freshness window.
        foreach (var second in new[] { 0, 10, 20 })
        {
            var at = T0.AddSeconds(second);
            Assert.Empty(core.OnMessage(Message("94.2", at), at).Raised);
        }

        Assert.Empty(core.OnTick(T0.AddSeconds(24), connected: true).Raised);
        var alert = Assert.Single(core.OnTick(T0.AddSeconds(25), connected: true).Raised);

        Assert.Equal(T0.AddSeconds(25), alert.FiredAt);

        // The body that started this For is five seconds old and every message since has replaced
        // it. Quoting it as this alert's sample would quote something that is no longer the case.
        Assert.Equal("above 90 for 25s", alert.Reason);
        Assert.Null(alert.Value);
        Assert.Null(alert.Sample);
    }

    [Fact]
    public void A_condition_that_goes_false_before_maturity_rings_nothing_and_restarts_the_clock()
    {
        var core = Core(Rule(Above(90), forSeconds: 30));
        var raised = new List<Alert>();

        for (var second = 0; second <= 60; second++)
        {
            var at = T0.AddSeconds(second);
            var payload = second == 20 ? "80" : "94.2";   // one dip, ten seconds before maturity
            raised.AddRange(core.OnMessage(Message(payload, at), at).Raised);
            raised.AddRange(core.OnTick(at, connected: true).Raised);

            // Nothing at T0+30: the run that started at T0 was broken, and the run that replaced
            // it started at T0+21.
            if (second < 51)
                Assert.Empty(raised);
        }

        var alert = Assert.Single(raised);
        Assert.Equal(T0.AddSeconds(51), alert.FiredAt);
    }

    [Fact]
    public void A_skipped_verdict_neither_confirms_nor_breaks_maturity()
    {
        var core = Core(Rule(Above(90), forSeconds: 30, field: "$.temp"));

        Assert.Empty(core.OnMessage(Message("{\"temp\":94.2}", T0), T0).Raised);

        // Twenty-nine messages that carry no temp at all. The field is absent, so the condition
        // is skipped: it is not false, and a rule that reads '> 90' must not be broken by a
        // device saying 'warming up'.
        for (var second = 1; second < 30; second++)
        {
            var at = T0.AddSeconds(second);
            Assert.Empty(core.OnMessage(Message("{\"fan\":\"off\"}", at), at).Raised);
            Assert.Empty(core.OnTick(at, connected: true).Raised);
        }

        var alert = Assert.Single(core.OnTick(T0.AddSeconds(30), connected: true).Raised);
        Assert.Equal(T0.AddSeconds(30), alert.FiredAt);

        var diagnostic = Assert.Single(core.Snapshot().Rules);
        Assert.Equal(1, diagnostic.Evaluated);
        Assert.Equal(29, diagnostic.Skipped);
    }

    [Fact]
    public void Maturation_does_not_complete_on_a_tick_when_nothing_has_been_judged_for_a_minute()
    {
        var core = Core(Rule(Above(90), forSeconds: 120));

        Assert.Empty(core.OnMessage(Message("94.2", T0), T0).Raised);

        // The topic stops sending. Two hundred seconds of ticks, every one of them past the For,
        // and none of them rings: a device that went quiet mid-For must not mature its own timer.
        // A half-finished For plus silence is not a threshold breach — silence has its own rule.
        for (var second = 1; second <= 200; second++)
            Assert.Empty(core.OnTick(T0.AddSeconds(second), connected: true).Raised);

        // One real message, still over the line. The run was never broken, only unproven, so it
        // rings at once rather than starting another two minutes.
        var at = T0.AddSeconds(201);
        var alert = Assert.Single(core.OnMessage(Message("94.2", at), at).Raised);
        Assert.Equal(at, alert.FiredAt);
    }

    [Fact]
    public void Skipped_arrivals_do_not_keep_a_pair_fresh()
    {
        var core = Core(Rule(Above(90), forSeconds: 120, field: "$.temp"));

        Assert.Empty(core.OnMessage(Message("{\"temp\":94.2}", T0), T0).Raised);

        // Ninety seconds of chatter that cannot be judged. It keeps the topic alive but it does
        // not keep the judgement fresh, so the gate stays shut past the For.
        for (var second = 1; second <= 130; second++)
        {
            var at = T0.AddSeconds(second);
            Assert.Empty(core.OnMessage(Message("{\"fan\":\"off\"}", at), at).Raised);
            Assert.Empty(core.OnTick(at, connected: true).Raised);
        }

        var last = T0.AddSeconds(131);
        Assert.Single(core.OnMessage(Message("{\"temp\":94.2}", last), last).Raised);
    }

    [Fact]
    public void Maturity_completes_exactly_on_the_boundary_second()
    {
        var core = Core(Rule(Above(90), forSeconds: 5));

        Assert.Empty(core.OnMessage(Message("94.2", T0), T0).Raised);
        Assert.Empty(core.OnTick(T0.AddSeconds(4).AddMilliseconds(999), connected: true).Raised);

        var alert = Assert.Single(core.OnTick(T0.AddSeconds(5), connected: true).Raised);
        Assert.Equal(T0.AddSeconds(5), alert.FiredAt);
    }

    [Fact]
    public void The_freshness_window_is_inclusive_at_sixty_seconds()
    {
        var onTheLine = Core(Rule(Above(90), forSeconds: 45));
        Assert.Empty(onTheLine.OnMessage(Message("94.2", T0), T0).Raised);
        Assert.Single(onTheLine.OnTick(T0.AddSeconds(60), connected: true).Raised);

        var justPast = Core(Rule(Above(90), forSeconds: 45));
        Assert.Empty(justPast.OnMessage(Message("94.2", T0), T0).Raised);
        Assert.Empty(justPast.OnTick(T0.AddSeconds(60).AddMilliseconds(1), connected: true).Raised);
    }
}
