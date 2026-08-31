using System.Text.Json;
using MqttForge.Application.Alerts.Statistics;
using MqttForge.Domain.Models;
using Xunit;

namespace MqttForge.UnitTests.Application.Alerts;

/// <summary>One reading out of a shared vector.</summary>
public sealed record VectorReading(double Value, long AtMs);

public sealed record VectorFences(double Low, double High);

public sealed record VectorSummary(
    int N,
    double Low,
    double High,
    double Mean,
    double Median,
    double Sd,
    double Q1,
    double Q3,
    VectorFences Fences,
    IReadOnlyList<int> Outliers,
    double Slope);

public sealed record VectorFit(
    string Name,
    double? Mean,
    double? Sd,
    double? Low,
    double? High,
    double D,
    double Critical);

public sealed record VectorPulses(
    double Rest,
    double Peak,
    double Threshold,
    int Count,
    double Duty,
    double? Every,
    double? Width);

public sealed record VectorShape(string Id, int Levels, VectorPulses? Pulses);

public sealed record VectorExpected(
    VectorSummary Summary,
    VectorFit? Fit,
    VectorShape Shape,
    VectorPulses Pulses);

public sealed record StatisticsVector(
    string Name,
    IReadOnlyList<VectorReading> Readings,
    VectorExpected Expected);

/// <summary>
/// The vectors both sides of the console are measured against.
/// </summary>
/// <remarks>
/// The engine's statistics and web/src/lib's statistics are the same arithmetic written twice,
/// and nothing else in the build makes them stay that way. Someone reaches for a sample
/// deviation instead of a population one, or tidies away the un-interpolated median inside
/// spiking because it looks like an oversight, and the chart starts saying one thing while the
/// alert says another about the same readings. That is two tools and no answer.
///
/// So: ten runs, every number both sides should produce from them, and two readers. This one
/// checks all four blocks; web/src/lib/sharedVectors.test.ts checks the three the console's
/// public surface can reach. A change on either side that moves an answer turns a test red on
/// the side that moved, and the failure names the vector, the field and the gap.
///
/// The files are owned by nobody's implementation. Do not edit a number in them to make a test
/// pass — every one was produced by running the TypeScript originals over these exact readings.
/// An expected value that no longer matches is a report that the arithmetic changed.
/// </remarks>
public class SharedVectorsTests
{
    /// <summary>
    /// How far apart the two runtimes are allowed to be.
    /// </summary>
    // Everything in Summary is addition, subtraction, multiplication, division, comparison and
    // one square root, all of which IEEE 754 requires to be correctly rounded — and both sides
    // do them in the same order, on values parsed from the same decimal literals, so in practice
    // every one of them matches bit for bit. The one place the runtimes may legitimately differ
    // is Math.Exp, inside the normal candidate's error function and inside the exponential
    // candidate's own CDF: neither .NET nor V8 promises a correctly-rounded exponential, and each
    // is free to be an ulp or two out. On a quantity of order one that is about 1e-16.
    //
    // 1e-9 is therefore seven orders of margin over the only real source of disagreement, and
    // still far tighter than any change anybody could make to this arithmetic without meaning to.
    // Counts, indices and names are compared exactly; a tolerance on an integer would be a way of
    // not noticing.
    private const double Tolerance = 1e-9;

    /// <summary>Where the Content item in the csproj puts the vectors.</summary>
    private static readonly string Directory =
        Path.Combine(AppContext.BaseDirectory, "fixtures", "statistics");

    private static readonly JsonSerializerOptions Wire = new() { PropertyNameCaseInsensitive = true };

    private static readonly IReadOnlyDictionary<string, StatisticsVector> Vectors = Load();

    private static IReadOnlyDictionary<string, StatisticsVector> Load()
    {
        // An empty dictionary rather than a throw, so a missing output directory fails as the
        // guard test below with a sentence in it, instead of as an exception during discovery
        // that names a path and no reason.
        if (!System.IO.Directory.Exists(Directory)) return new Dictionary<string, StatisticsVector>();

        var loaded = new Dictionary<string, StatisticsVector>(StringComparer.Ordinal);

        foreach (var file in System.IO.Directory.GetFiles(Directory, "*.json"))
        {
            var vector = JsonSerializer.Deserialize<StatisticsVector>(File.ReadAllText(file), Wire)
                ?? throw new InvalidOperationException($"{file} is not a vector.");

            loaded.Add(vector.Name, vector);
        }

        return loaded;
    }

    public static TheoryData<string> Names() => [.. Vectors.Keys.Order(StringComparer.Ordinal)];

    [Fact]
    public void Finds_every_vector_it_is_meant_to_check()
    {
        Assert.True(
            Vectors.Count >= 8,
            $"Expected at least eight shared vectors in {Directory}, found {Vectors.Count}. " +
            "They are copied there by the Content item in MqttForge.UnitTests.csproj; " +
            "a missing directory means that item is gone or the glob no longer matches.");
    }

    [Theory]
    [MemberData(nameof(Names))]
    public void Answers_the_vector(string name)
    {
        var vector = Vectors[name];
        var readings = ReadingsOf(vector);
        var values = ValuesOf(vector);

        var summary = Statistics.Summarise(values) ?? throw new InvalidOperationException("no summary");

        AssertSummary(name, vector.Expected.Summary, summary);
        AssertFit(name, vector.Expected.Fit, Distribution.Of(values));
        AssertShape(name, vector.Expected.Shape, Shapes.Of(readings, summary));
        AssertPulses(name, "pulses", vector.Expected.Pulses, Shapes.PulsesOf(readings, summary));
    }

    private static void AssertSummary(string name, VectorSummary expected, Summary actual)
    {
        Assert.Equal(expected.N, actual.N);
        Close(name, "summary.low", expected.Low, actual.Low);
        Close(name, "summary.high", expected.High, actual.High);
        Close(name, "summary.mean", expected.Mean, actual.Mean);
        Close(name, "summary.median", expected.Median, actual.Median);
        Close(name, "summary.sd", expected.Sd, actual.Sd);
        Close(name, "summary.q1", expected.Q1, actual.Q1);
        Close(name, "summary.q3", expected.Q3, actual.Q3);
        Close(name, "summary.fences.low", expected.Fences.Low, actual.Fences.Low);
        Close(name, "summary.fences.high", expected.Fences.High, actual.Fences.High);
        Close(name, "summary.slope", expected.Slope, actual.Slope);

        // Indices, in order. Exact, and the whole list at once so a failure prints both.
        Assert.Equal(expected.Outliers, actual.Outliers);
    }

    private static void AssertFit(string name, VectorFit? expected, Fit? actual)
    {
        if (expected is null)
        {
            Assert.True(actual is null, $"{name}.fit: the vector says nothing fits, this side named {actual?.Name}.");
            return;
        }

        Assert.NotNull(actual);
        Assert.Equal(expected.Name, actual.Name.ToString(), ignoreCase: true);

        Nullable(name, "fit.mean", expected.Mean, actual.Mean);
        Nullable(name, "fit.sd", expected.Sd, actual.Sd);
        Nullable(name, "fit.low", expected.Low, actual.Low);
        Nullable(name, "fit.high", expected.High, actual.High);
        Close(name, "fit.d", expected.D, actual.D);
        Close(name, "fit.critical", expected.Critical, actual.Critical);
    }

    private static void AssertShape(string name, VectorShape expected, Shape actual)
    {
        Assert.Equal(expected.Id, actual.Id.ToString(), ignoreCase: true);
        Assert.Equal(expected.Levels, actual.Levels);

        if (expected.Pulses is null)
        {
            Assert.True(actual.Pulses is null, $"{name}.shape.pulses: the vector says none, this side has some.");
            return;
        }

        Assert.NotNull(actual.Pulses);
        AssertPulses(name, "shape.pulses", expected.Pulses, actual.Pulses);
    }

    private static void AssertPulses(string name, string field, VectorPulses expected, Pulses actual)
    {
        Close(name, $"{field}.rest", expected.Rest, actual.Rest);
        Close(name, $"{field}.peak", expected.Peak, actual.Peak);
        Close(name, $"{field}.threshold", expected.Threshold, actual.Threshold);
        Assert.Equal(expected.Count, actual.Count);
        Close(name, $"{field}.duty", expected.Duty, actual.Duty);
        Nullable(name, $"{field}.every", expected.Every, actual.Every);
        Nullable(name, $"{field}.width", expected.Width, actual.Width);
    }

    /// <summary>A null is a fact here, not a missing value: it says the metric does not exist.</summary>
    private static void Nullable(string name, string field, double? expected, double? actual)
    {
        if (expected is null)
        {
            Assert.True(actual is null, $"{name}.{field}: the vector says null, this side answers {actual}.");
            return;
        }

        Assert.True(actual is not null, $"{name}.{field}: the vector says {expected:R}, this side answers null.");
        Close(name, field, expected.Value, actual.Value);
    }

    // The failure sentence is the point of this helper. Assert.Equal(double, double, precision)
    // would print two numbers and leave the reader to work out which vector and which field they
    // came from, on a run where every one of the ten vectors is checking eleven of them.
    //
    // What a broken vector looks like: change flat-line.json's summary.sd from 0 to 0.5 and the
    // run goes red with
    //
    //   Answers_the_vector(name: "flat-line")
    //     flat-line.summary.sd: the vector says 0.5, this side answers 0 — 0.5 apart, and the
    //     tolerance is 1E-09.
    //
    // which names the file to open and the line in it. The same edit on the web side gives the
    // same sentence, because sharedVectors.test.ts builds it the same way — so a real drift is
    // reported twice, once per side, and a bad vector is reported twice too. Two reds from one
    // edit is how you tell the fixture is wrong rather than the code.
    private static void Close(string name, string field, double expected, double actual)
    {
        Assert.True(
            Math.Abs(expected - actual) <= Tolerance,
            $"{name}.{field}: the vector says {expected:R}, this side answers {actual:R} — " +
            $"{Math.Abs(expected - actual):R} apart, and the tolerance is {Tolerance:R}.");
    }

    private static double[] ValuesOf(StatisticsVector vector)
    {
        var values = new double[vector.Readings.Count];
        for (var index = 0; index < values.Length; index++) values[index] = vector.Readings[index].Value;

        return values;
    }

    private static Reading[] ReadingsOf(StatisticsVector vector)
    {
        var readings = new Reading[vector.Readings.Count];
        for (var index = 0; index < readings.Length; index++)
            readings[index] = new Reading(
                DateTimeOffset.FromUnixTimeMilliseconds(vector.Readings[index].AtMs).UtcTicks,
                vector.Readings[index].Value);

        return readings;
    }
}
