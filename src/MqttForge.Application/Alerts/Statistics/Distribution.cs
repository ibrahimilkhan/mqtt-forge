using System.Buffers;

namespace MqttForge.Application.Alerts.Statistics;

public enum FitName
{
    Normal,
    Uniform,
    Exponential,
}

/// <summary>
/// A named shape and the numbers that earned it the name.
///
/// The parameters are a flat union rather than a bag: a normal carries its mean and deviation, a
/// uniform the ends it runs between, an exponential its mean wait alone. Whichever the fit does
/// not have is null, which is how the original's optional params read once they cross into a
/// language that will not let a record grow a field per candidate.
/// </summary>
/// <param name="D">The largest gap found.</param>
/// <param name="Critical">The largest gap a run this long is allowed before the name is refused.</param>
public sealed record Fit(
    FitName Name,
    double? Mean,
    double? Sd,
    double? Low,
    double? High,
    double D,
    double Critical);

/// <summary>
/// Whether a run of readings has a shape with a name.
///
/// The engine-side mirror of web/src/lib/distribution.ts. The test is Kolmogorov-Smirnov: the
/// largest gap between where the readings actually fall and where the candidate says they should.
/// Parameters are estimated from the readings themselves, which makes the standard critical values
/// too generous, so the corrected ones are used below. They are the published approximations at
/// the five per cent level rather than exact tables - enough to keep a wrong name off the chart,
/// not enough to publish a paper with.
///
/// A rule fires on this only when the name it settles on CHANGES, so what matters far more than
/// the test being the best available is that it be the same test the browser ran. An engine that
/// quietly used a better statistic would call a topic normal in one pane and uniform in the other.
/// </summary>
public static class Distribution
{
    /// <summary>Below this any shape fits anything, and a verdict is a guess wearing the clothes of a measure.</summary>
    public const int MinSample = 12;

    public static Fit? Of(ReadOnlySpan<double> values)
    {
        if (values.Length < MinSample) return null;

        var n = values.Length;
        var rented = ArrayPool<double>.Shared.Rent(n);

        try
        {
            values.CopyTo(rented);
            var sorted = rented.AsSpan(0, n);
            sorted.Sort();

            var root = Math.Sqrt(n);

            // Summed over the SORTED copy, because the original computes both from its sorted
            // array. Statistics.Summarise sums in arrival order for the same reason in reverse.
            // The two agree to about the last bit, and the mirrors are kept exact rather than
            // shared so that neither drifts when the other is touched.
            double total = 0;
            foreach (var value in sorted) total += value;
            var mean = total / n;

            double spread = 0;
            foreach (var value in sorted) spread += (value - mean) * (value - mean);
            var sd = Math.Sqrt(spread / n);

            var low = sorted[0];
            var high = sorted[n - 1];

            // Nothing to describe, and every candidate below divides by one of these.
            if (sd == 0 || high == low) return null;

            var normal = new Fit(
                FitName.Normal,
                mean,
                sd,
                null,
                null,
                LargestGap(sorted, value => NormalCdf((value - mean) / sd)),
                // Lilliefors, for a normal whose mean and deviation came from the sample itself.
                0.895 / (root - 0.01 + 0.85 / root));

            var uniform = new Fit(
                FitName.Uniform,
                null,
                null,
                low,
                high,
                LargestGap(sorted, value => (value - low) / (high - low)),
                // Tighter than the 1.36/root-n of the tables: the ends were estimated from the
                // sample too.
                1.09 / root);

            // A wait cannot be negative, and a run that goes below zero is not one however well
            // it fits. The mean is guarded as well, since it is the divisor in the curve.
            var exponential = low >= 0 && mean > 0
                ? new Fit(
                    FitName.Exponential,
                    mean,
                    null,
                    null,
                    null,
                    LargestGap(sorted, value => 1 - Math.Exp(-value / mean)),
                    1.06 / root)
                : null;

            // The best fit is the one furthest inside its own limit, not the one with the smallest
            // gap: the limits differ, so the gaps are not comparable on their own.
            return Better(Better(Better(null, normal), uniform), exponential);
        }
        finally
        {
            ArrayPool<double>.Shared.Return(rented);
        }
    }

    /// <summary>
    /// The better of two candidates by how much slack each has left inside its own limit, with a
    /// candidate that did not pass at all discarded.
    ///
    /// Strictly greater, so a tie keeps the one offered first. That reproduces the original, which
    /// sorts the passing candidates and takes the head: sort is stable in JavaScript, so a dead
    /// heat there also leaves them in candidate order - normal, then uniform, then exponential.
    /// </summary>
    private static Fit? Better(Fit? best, Fit? candidate)
    {
        if (candidate is null || candidate.D >= candidate.Critical) return best;
        if (best is null) return candidate;

        return candidate.Critical - candidate.D > best.Critical - best.D ? candidate : best;
    }

    /// <summary>
    /// The Kolmogorov-Smirnov statistic: the largest distance between the readings' own step and
    /// the candidate's curve, measured on both sides of every step.
    /// </summary>
    private static double LargestGap(ReadOnlySpan<double> sorted, Func<double, double> cdf)
    {
        double largest = 0;

        for (var index = 0; index < sorted.Length; index++)
        {
            var expected = Math.Min(Math.Max(cdf(sorted[index]), 0), 1);

            largest = Math.Max(largest, (index + 1d) / sorted.Length - expected);
            largest = Math.Max(largest, expected - (double)index / sorted.Length);
        }

        return largest;
    }

    /// <summary>
    /// The standard normal's curve, by Zelen and Severo's approximation - accurate to about
    /// 7.5e-8, which is far inside anything the test above can tell apart.
    /// </summary>
    private static double NormalCdf(double z)
    {
        var sign = z < 0 ? -1 : 1;
        var x = Math.Abs(z) / Math.Sqrt(2);

        var t = 1 / (1 + 0.3275911 * x);
        var error =
            1 -
            ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
            t *
            Math.Exp(-x * x);

        return 0.5 * (1 + sign * error);
    }
}
