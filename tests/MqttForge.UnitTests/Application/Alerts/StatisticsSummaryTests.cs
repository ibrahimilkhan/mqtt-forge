using MqttForge.Application.Alerts.Statistics;

namespace MqttForge.UnitTests.Application.Alerts;

public class StatisticsSummaryTests
{
    private static Summary Of(params double[] values) =>
        Statistics.Summarise(values) ?? throw new InvalidOperationException("no summary");

    [Fact]
    public void An_empty_run_has_nothing_to_say()
    {
        Assert.Null(Statistics.Summarise(ReadOnlySpan<double>.Empty));
    }

    [Fact]
    public void One_reading_is_every_number_at_once()
    {
        var summary = Of(42.5);

        Assert.Equal(1, summary.N);
        Assert.Equal(42.5, summary.Low);
        Assert.Equal(42.5, summary.High);
        Assert.Equal(42.5, summary.Mean);
        Assert.Equal(42.5, summary.Median);
        Assert.Equal(0, summary.Sd);
        Assert.Equal(new Fences(42.5, 42.5), summary.Fences);
        Assert.Empty(summary.Outliers);
        Assert.Equal(0, summary.Slope);
    }

    [Fact]
    public void Two_readings_have_a_box_between_them_and_a_slope_through_them()
    {
        var summary = Of(10, 20);

        Assert.Equal(15, summary.Mean);
        Assert.Equal(15, summary.Median);
        Assert.Equal(5, summary.Sd);
        Assert.Equal(12.5, summary.Q1);
        Assert.Equal(17.5, summary.Q3);
        Assert.Equal(new Fences(5, 25), summary.Fences);
        Assert.Equal(10, summary.Slope);
    }

    [Fact]
    public void The_middle_of_an_odd_count_is_the_reading_in_the_middle()
    {
        Assert.Equal(3, Of(5, 1, 3).Median);
    }

    [Fact]
    public void The_middle_of_an_even_count_is_the_midpoint_of_the_pair()
    {
        Assert.Equal(2.5, Of(1, 2, 3, 4).Median);
    }

    [Fact]
    public void The_quarters_fall_between_readings_by_linear_interpolation()
    {
        // Eight readings put the quarter at position 1.75, three quarters of the way from the
        // second reading to the third: 2 + 0.75 = 2.75. The interpolation is the original's, and
        // it is not the only defensible one - which is exactly why it is pinned here.
        var summary = Of(1, 2, 3, 4, 5, 6, 7, 8);

        Assert.Equal(2.75, summary.Q1);
        Assert.Equal(6.25, summary.Q3);
    }

    [Fact]
    public void The_spread_is_the_population_deviation()
    {
        // The textbook run: population deviation 2, sample deviation 2.138. If this ever reads
        // 2.138 the mirror has been "corrected" and the panel and the engine no longer agree.
        Assert.Equal(2, Of(2, 4, 4, 4, 5, 5, 7, 9).Sd);
    }

    [Fact]
    public void A_reading_past_the_upper_fence_is_marked()
    {
        Assert.Equal([7], Of(10, 11, 12, 11, 10, 12, 11, 90).Outliers);
    }

    [Fact]
    public void Both_ends_are_marked_and_in_the_order_they_arrived()
    {
        // Indices into the run as it arrived, not into the sorted copy: a rule reporting which
        // reading was odd has to be able to point at it in the log.
        var summary = Of(-40, 10, 11, 12, 11, 10, 12, 11, 90);

        Assert.Equal(new Fences(7, 15), summary.Fences);
        Assert.Equal([0, 8], summary.Outliers);
    }

    [Fact]
    public void Nothing_is_marked_when_every_reading_sits_inside_the_fences()
    {
        Assert.Empty(Of(10, 11, 12, 11, 10, 12).Outliers);
    }

    [Fact]
    public void A_line_pinned_at_the_top_of_its_range_has_no_outliers_at_all()
    {
        // The spec's 4-20mA case: a transmitter railed at 20.0 and held there. There is no box to
        // measure a fence against, so this file says nothing is far from it - and it is the
        // outlier condition, in its own task, that decides a reading of 400 is worth waking
        // someone for. Getting that division wrong is how a pinned sensor goes unreported.
        var pinned = new double[200];
        Array.Fill(pinned, 20.0);

        var summary = Of(pinned);

        Assert.Equal(0, summary.Sd);
        Assert.Equal(summary.Q1, summary.Q3);
        Assert.Equal(new Fences(20, 20), summary.Fences);
        Assert.Empty(summary.Outliers);
        Assert.Equal(0, summary.Slope);
    }

    [Fact]
    public void The_slope_says_which_way_the_run_is_going()
    {
        Assert.Equal(0, Of(3, 3, 3, 3).Slope);
        Assert.Equal(1, Of(1, 2, 3, 4, 5).Slope);
        Assert.Equal(-1, Of(5, 4, 3, 2, 1).Slope);
    }

    [Fact]
    public void A_run_with_a_NaN_in_it_claims_nothing_and_throws_nothing()
    {
        // The caller filters non-finite payloads, and the original does not guard either. The
        // point of the test is that an unfiltered NaN poisons the numbers rather than throwing,
        // and compares false against both fences - so the run claims nothing, which is the right
        // way for this to fail.
        var summary = Of(10, double.NaN, 12);

        Assert.True(double.IsNaN(summary.Mean));
        Assert.Empty(summary.Outliers);
    }

    [Fact]
    public void A_run_with_an_infinity_in_it_claims_nothing_and_throws_nothing()
    {
        var summary = Of(10, double.PositiveInfinity, 12);

        Assert.True(double.IsPositiveInfinity(summary.High));
        Assert.Empty(summary.Outliers);
    }
}
