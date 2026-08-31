using MqttForge.Application.Alerts;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Alerts;

/// <summary>
/// The condition the whole confirmation machine exists for.
///
/// A distribution fit is a five per cent test, which means one window in twenty of a perfectly
/// healthy stream fits nothing at all — and a naive implementation would ring on every one of
/// them. The first test here is the spec's own: an hour of a steady N(20,2) at fifty a second,
/// and not one alert. The second is the other half of the bargain, because a rule that never
/// fires is not a rule: a stream that really does change its distribution has to say so, once.
/// </summary>
public class DistributionShiftTests
{
    private static AlertEngineCore Core(int window = 200) =>
        AlertEngineFixture.Core(AlertEngineFixture.Rule(new DistributionShiftCondition(window)));

    // The spec, "Bir saat boyunca sabit bir akış sıfır alarm üretmelidir". A hundred and eighty
    // thousand readings, three and a half thousand cycles, and every one of them either 'normal'
    // or 'nothing fits' — which is exactly the case the machine has to sit still through.
    [Fact]
    public void An_hour_of_a_steady_normal_stream_produces_no_alert()
    {
        var core = Core();
        var bell = new Bell(20260830, 20, 2);

        var fed = Streams.Feed(core, Enumerable.Range(0, 180_000).Select(_ => bell.Next()),
                               AlertEngineFixture.T0, TimeSpan.FromMilliseconds(20));

        Assert.Empty(fed.Raised);
        Assert.Empty(core.Snapshot().Active);
    }

    // A real transition, and the two things that have to be true about it: it is reported, and it
    // is reported once. A second between readings, so the once-a-second quota never holds up a
    // cycle and the timing here is the machine's own — a quarter of a window between cycles, two
    // cycles to believe a name.
    [Fact]
    public void A_normal_stream_that_becomes_uniform_fires_exactly_one_alert()
    {
        var core = Core();
        var bell = new Bell(7, 20, 2);
        var flat = new Bell(99, 0, 0);

        var settled = Streams.Feed(core, Enumerable.Range(0, 400).Select(_ => bell.Next()),
                                   AlertEngineFixture.T0, TimeSpan.FromSeconds(1));
        Assert.Empty(settled.Raised);

        // Two windows of the new stream, which is the whole budget the spec allows the machine.
        var changed = Streams.Feed(core, Enumerable.Range(0, 400).Select(_ => flat.Flat(10, 30)),
                                   settled.At, TimeSpan.FromSeconds(1));

        var alert = Assert.Single(changed.Raised);
        Assert.Contains("uniform", alert.Reason, StringComparison.Ordinal);
        Assert.Contains("normal", alert.Reason, StringComparison.Ordinal);
    }

    // A window that fits nothing is not a change of distribution — it is a window with nothing to
    // say — and it must neither ring nor overwrite what the pair had settled on. Both directions
    // are checked, because the expensive mistake is the second one: an engine that let 'unknown'
    // become the baseline would ring on the way back to normal, which is the moment everything is
    // fine again.
    [Fact]
    public void A_window_that_fits_nothing_never_fires_and_never_becomes_the_baseline()
    {
        var core = Core();
        var bell = new Bell(11, 20, 2);

        var settled = Streams.Feed(core, Enumerable.Range(0, 400).Select(_ => bell.Next()),
                                   AlertEngineFixture.T0, TimeSpan.FromSeconds(1));

        // Two levels a hundred apart, alternating: not normal, not uniform, not exponential.
        var split = Streams.Feed(core, Enumerable.Range(0, 400).Select(i => i % 2 == 0 ? 0.05 : 100.05),
                                 settled.At, TimeSpan.FromSeconds(1));

        var back = Streams.Feed(core, Enumerable.Range(0, 400).Select(_ => bell.Next()),
                                split.At, TimeSpan.FromSeconds(1));

        Assert.Empty(split.Raised);
        Assert.Empty(back.Raised);
    }

    // Below the minimum a pair claims nothing at all, and 'nothing' has to be Skipped rather than
    // False: False is an answer, and an answer here would clear an alarm somebody else raised.
    [Fact]
    public void A_pair_below_the_minimum_run_is_skipped_rather_than_judged()
    {
        var core = Core();
        var bell = new Bell(3, 20, 2);

        var fed = Streams.Feed(core, Enumerable.Range(0, 10).Select(_ => bell.Next()),
                               AlertEngineFixture.T0, TimeSpan.FromSeconds(1));

        var diagnostic = Assert.Single(core.Snapshot().Rules);

        Assert.Empty(fed.Raised);
        Assert.Equal(10L, diagnostic.Skipped);
        Assert.Equal(0L, diagnostic.Evaluated);
    }

    // A run that sits on the line between two shapes, and what the reader is spared.
    //
    // Measured while this file was written, on the stream below: over 1196 cycles the raw KS
    // verdict changes its mind 77 times between 'normal' and 'uniform', and comes back null in
    // 885 of them. The reader gets one alert. That ratio is the point of the whole edge design.
    //
    // What is NOT pinned here, and the measurement is worth recording so nobody assumes it is:
    // moving BelievedAfter from 2 to 1, or WindowInCycles from 4 to 1, leaves this at one alert.
    // The dominant suppressor on a stream like this is not the confirmation counter at all — it
    // is that a pair with an alert already standing cannot raise a second one, and that a null
    // verdict keeps the confirmed name rather than becoming a candidate. The counters matter for
    // a pair that resolves and re-fires; nothing in this suite exercises that, and pretending
    // otherwise would be a comment doing work a test is not.
    //
    // The hour of steady readings above is the same story from the other side: 3596 cycles, zero
    // flips, 213 nulls — 5.92%, which is the five per cent level turning up exactly where
    // distribution.ts's own comment says it will. It proves the null rule and nothing else.
    [Fact]
    public void A_run_that_sits_on_the_line_between_two_shapes_is_not_a_run_of_alerts()
    {
        var core = Core();
        var noise = new Bell(13, 0, 1);

        var fed = Streams.Feed(
            core,
            Enumerable.Range(0, 60_000).Select(i => 20 + i % 7 * 0.9 + noise.Next() * 0.6),
            AlertEngineFixture.T0,
            TimeSpan.FromMilliseconds(20));

        // Seventy-seven raw changes of mind, measured. Ten is a ceiling with room in it rather
        // than a transcription of today's answer: what is being pinned is the order of magnitude
        // the machine buys, not a number that would have to be edited every time the arithmetic
        // moves in its last digit.
        Assert.True(fed.Raised.Count <= 10,
            $"the confirmation machine let {fed.Raised.Count} alerts through where the raw verdict changed 77 times");
    }
}
