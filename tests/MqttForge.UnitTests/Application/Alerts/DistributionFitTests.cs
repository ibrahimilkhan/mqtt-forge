using MqttForge.Application.Alerts.Statistics;

namespace MqttForge.UnitTests.Application.Alerts;

public class DistributionFitTests
{
    /// <summary>
    /// A fixed-seed linear congruential generator, written out here rather than taken from
    /// Random, so that these samples are the same numbers on every machine and every morning.
    /// A statistical test that draws afresh each run is a test that eventually fails on the
    /// build server alone, and there is nothing to learn from that failure.
    ///
    /// The half-step in the numerator keeps a draw off exactly zero, which the exponential
    /// shape below would turn into an infinity.
    /// </summary>
    private static double[] Draws(uint seed, int count, Func<double, Func<double>, double> shape)
    {
        var state = (ulong)seed;

        double Next()
        {
            state = (state * 1664525 + 1013904223) % 4294967296;
            return (state + 0.5) / 4294967296;
        }

        var drawn = new double[count];
        for (var i = 0; i < count; i++) drawn[i] = shape(Next(), Next);

        return drawn;
    }

    private static double[] Uniforms(uint seed, int count) => Draws(seed, count, (uniform, _) => uniform);

    /// <summary>Box-Muller, which is why the shape is handed a second draw it may or may not take.</summary>
    private static double[] Normals(uint seed, int count) =>
        Draws(seed, count, (uniform, next) =>
            20 + 2 * Math.Sqrt(-2 * Math.Log(uniform)) * Math.Cos(2 * Math.PI * next()));

    private static double[] Exponentials(uint seed, int count) =>
        Draws(seed, count, (uniform, _) => -Math.Log(uniform) * 5);

    private static double[] Ramp(int count) =>
        [.. Enumerable.Range(1, count).Select(step => (double)step)];

    private static Fit Fitted(double[] values) =>
        Distribution.Of(values) ?? throw new InvalidOperationException("no fit");

    [Fact]
    public void The_generator_draws_the_same_numbers_the_web_generator_draws()
    {
        // The same three numbers the identical LCG produces under node. Everything else in this
        // file rests on the samples being the browser's samples, so the generator is pinned
        // before any verdict taken from it is.
        var drawn = Uniforms(11, 3);

        Assert.Equal(0.24033104965928942, drawn[0], 15);
        Assert.Equal(0.27630832546856254, drawn[1], 15);
        Assert.Equal(0.3513247558148578, drawn[2], 15);
    }

    [Fact]
    public void Too_few_readings_are_nameless()
    {
        Assert.Null(Distribution.Of(Normals(7, Distribution.MinSample - 1)));
    }

    [Fact]
    public void The_shortest_run_that_can_be_named_is_named()
    {
        Assert.NotNull(Distribution.Of(Normals(7, Distribution.MinSample)));
    }

    [Fact]
    public void A_run_that_never_moved_is_nameless()
    {
        // Both guards at once: no deviation, and the two ends equal. Every candidate divides by
        // one of them, so the answer is no name rather than an infinity.
        var still = new double[40];
        Array.Fill(still, 21.5);

        Assert.Null(Distribution.Of(still));
    }

    [Fact]
    public void A_normal_sample_is_called_normal_and_carries_its_mean_and_deviation()
    {
        var fit = Fitted(Normals(7, 120));

        Assert.Equal(FitName.Normal, fit.Name);
        Assert.Equal(20.242, fit.Mean!.Value, 3);
        Assert.Equal(2.160, fit.Sd!.Value, 3);
        Assert.Null(fit.Low);
        Assert.Null(fit.High);
        // The gap the TypeScript original reports on this very sample, run through node.
        Assert.Equal(0.038777, fit.D, 6);
    }

    [Fact]
    public void An_even_ramp_is_uniform_and_carries_the_ends_it_runs_between()
    {
        var fit = Fitted(Ramp(40));

        Assert.Equal(FitName.Uniform, fit.Name);
        Assert.Equal(1, fit.Low!.Value);
        Assert.Equal(40, fit.High!.Value);
        Assert.Null(fit.Mean);
        Assert.Null(fit.Sd);
        Assert.Equal(0.025, fit.D, 12);
        // The corrected limit, tighter than the 1.36/root-n of the tables, because the ends were
        // estimated from the sample itself.
        Assert.Equal(1.09 / Math.Sqrt(40), fit.Critical, 12);
    }

    [Fact]
    public void A_uniform_sample_is_called_uniform()
    {
        Assert.Equal(FitName.Uniform, Fitted(Uniforms(11, 120)).Name);
    }

    [Fact]
    public void An_exponential_sample_is_called_exponential_and_carries_its_mean_wait()
    {
        var fit = Fitted(Exponentials(3, 200));

        Assert.Equal(FitName.Exponential, fit.Name);
        Assert.Equal(4.613, fit.Mean!.Value, 3);
        Assert.Equal(0.0317196, fit.D, 7);
    }

    [Fact]
    public void A_run_that_goes_below_zero_is_never_exponential()
    {
        // The same exponential sample shifted down. It has exactly the shape it had before, and
        // it is still refused: a wait cannot be negative, so the name would be a lie however
        // well the curve fits.
        var below = Exponentials(3, 120).Select(value => value - 20).ToArray();

        Assert.Null(Distribution.Of(below));
    }

    [Fact]
    public void A_run_in_two_clumps_is_nameless()
    {
        // A two-state signal is not one of the three names, and saying nothing is the honest
        // answer. Task 3's shape test is what has something to say about this run.
        var clumped = Enumerable.Range(0, 60).Select(index => index % 2 == 0 ? 0d : 100d).ToArray();

        Assert.Null(Distribution.Of(clumped));
    }

    [Fact]
    public void The_winner_is_the_one_furthest_inside_its_own_limit_not_the_one_with_the_smallest_gap()
    {
        // The uniform sample wins on slack, not on gap: its own limit is the tighter of the two,
        // and the normal candidate's larger allowance is exactly what the comparison has to
        // discount. Picking the smallest d instead would call half the console's sensors normal.
        var sample = Uniforms(11, 120);
        var fit = Fitted(sample);

        var root = Math.Sqrt(sample.Length);
        var normalLimit = 0.895 / (root - 0.01 + 0.85 / root);

        Assert.Equal(FitName.Uniform, fit.Name);
        Assert.True(fit.D < fit.Critical);
        Assert.True(fit.Critical - fit.D < normalLimit);
        Assert.Equal(0.08886, fit.D, 5);
    }
}
