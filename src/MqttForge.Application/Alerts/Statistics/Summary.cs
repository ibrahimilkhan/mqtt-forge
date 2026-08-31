using System.Buffers;

namespace MqttForge.Application.Alerts.Statistics;

/// <summary>Tukey's fences - the usual line between spread and a reading that does not belong to it.</summary>
public readonly record struct Fences(double Low, double High);

/// <summary>
/// What a run of readings adds up to.
///
/// This is the engine-side mirror of web/src/lib/stats.ts summarise(). The console already says
/// these things about a topic in the browser, and a rule that fires on an outlier has to agree
/// with the panel the operator is looking at when they come to ask why it fired. So the numbers
/// are not re-derived here from better statistics - they are reproduced, quirks and all, and
/// where the original has a reason written down that reason is carried across with it.
/// </summary>
/// <param name="Sd">Population deviation: these are all the readings held, not a sample drawn from more.</param>
/// <param name="Outliers">Indices into the run, in arrival order.</param>
/// <param name="Slope">Least-squares slope in units per reading; zero when the run is flat.</param>
public sealed record Summary(
    int N,
    double Low,
    double High,
    double Mean,
    double Median,
    double Sd,
    double Q1,
    double Q3,
    Fences Fences,
    IReadOnlyList<int> Outliers,
    double Slope);

public static class Statistics
{
    /// <summary>Shared so that the common answer - no outliers - allocates nothing at all.</summary>
    private static readonly int[] NothingFarFromIt = [];

    /// <summary>
    /// Summarise a run of readings, or null when there is no run.
    ///
    /// The span is the ring's values as they arrived; it is copied before sorting, because the
    /// caller's ring is not ours to reorder and the outlier indices have to point back into
    /// arrival order to be any use to a rule.
    ///
    /// Nothing here guards against NaN or infinity. That is the mirror being faithful: the
    /// TypeScript does not guard either, and the engine filters non-finite payloads long before
    /// a reading reaches a window. A NaN that did get in poisons the mean and compares false
    /// against both fences, so the run simply claims nothing - which is the right failure.
    /// </summary>
    public static Summary? Summarise(ReadOnlySpan<double> values)
    {
        if (values.Length == 0) return null;

        var n = values.Length;
        var rented = ArrayPool<double>.Shared.Rent(n);

        try
        {
            values.CopyTo(rented);
            // Rent gives us at least n, usually more, so the sort has to be told where the run ends.
            var sorted = rented.AsSpan(0, n);
            sorted.Sort();

            // Summed in arrival order, as the original sums the unsorted array. Floating-point
            // addition is order-dependent, and Distribution.Of sums the sorted copy because its
            // original does; the two can differ in the last bits and both are correct mirrors.
            var mean = MeanOf(values);

            double spread = 0;
            foreach (var value in values) spread += (value - mean) * (value - mean);

            var q1 = Quantile(sorted, 0.25);
            var q3 = Quantile(sorted, 0.75);
            var iqr = q3 - q1;
            var fences = new Fences(q1 - 1.5 * iqr, q3 + 1.5 * iqr);

            return new Summary(
                n,
                sorted[0],
                sorted[n - 1],
                mean,
                Quantile(sorted, 0.5),
                Math.Sqrt(spread / n),
                q1,
                q3,
                fences,
                // A run that never moved has no box to measure a fence against, so nothing is far
                // from it. A 4-20mA line pinned at 20.0 lands here: two hundred identical readings,
                // no outliers, and it is the outlier condition - not this - that decides whether a
                // reading unlike them is worth waking anyone for.
                iqr == 0 ? NothingFarFromIt : OutliersOf(values, fences),
                SlopeOf(values));
        }
        finally
        {
            ArrayPool<double>.Shared.Return(rented);
        }
    }

    private static IReadOnlyList<int> OutliersOf(ReadOnlySpan<double> values, Fences fences)
    {
        List<int>? found = null;

        for (var index = 0; index < values.Length; index++)
        {
            if (values[index] < fences.Low || values[index] > fences.High)
            {
                found ??= [];
                found.Add(index);
            }
        }

        return found ?? (IReadOnlyList<int>)NothingFarFromIt;
    }

    private static double MeanOf(ReadOnlySpan<double> values)
    {
        double total = 0;
        foreach (var value in values) total += value;

        return total / values.Length;
    }

    /// <summary>Linear interpolation between the two readings the quantile falls between.</summary>
    private static double Quantile(ReadOnlySpan<double> sorted, double fraction)
    {
        var position = (sorted.Length - 1) * fraction;
        var below = (int)Math.Floor(position);
        var above = (int)Math.Ceiling(position);

        return below == above
            ? sorted[below]
            : sorted[below] + (sorted[above] - sorted[below]) * (position - below);
    }

    /// <summary>
    /// Least squares against the reading's place in the run, which is how the chart spaces them.
    ///
    /// Against the place rather than the clock: the chart draws the readings evenly whatever the
    /// gaps between them were, and a slope that disagreed with the line the operator can see
    /// would be a worse number however much better it was.
    /// </summary>
    private static double SlopeOf(ReadOnlySpan<double> values)
    {
        var n = values.Length;
        if (n < 2) return 0;

        var meanIndex = (n - 1) / 2d;
        var meanValue = MeanOf(values);

        double covariance = 0;
        double spread = 0;

        for (var index = 0; index < n; index++)
        {
            covariance += (index - meanIndex) * (values[index] - meanValue);
            spread += (index - meanIndex) * (index - meanIndex);
        }

        return spread == 0 ? 0 : covariance / spread;
    }
}
