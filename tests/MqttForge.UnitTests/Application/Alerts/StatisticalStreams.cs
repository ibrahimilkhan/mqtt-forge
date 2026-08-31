using System.Globalization;
using MqttForge.Application.Alerts;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Alerts;

/// <summary>What was fed to an engine, and what came back out of it.</summary>
internal sealed record Fed(List<Alert> Raised, DateTimeOffset At);

/// <summary>
/// A normal stream nobody has to trust a library for.
///
/// System.Random with a seed was the obvious choice and is the wrong one: the framework does not
/// promise the same sequence across runtime versions, and a test that fires on the build server
/// and not here would be read as a flaky engine rather than as a changed generator. This is
/// xorshift64* and Box-Muller, sixteen lines, and the same numbers for ever.
/// </summary>
internal sealed class Bell
{
    private ulong _state;
    private readonly double _mean;
    private readonly double _sd;
    private double? _spare;

    public Bell(ulong seed, double mean, double sd)
    {
        // Zero is the one state xorshift cannot leave, so it is not allowed to be the seed.
        _state = seed == 0 ? 1 : seed;
        _mean = mean;
        _sd = sd;
    }

    /// <summary>A number in (0,1) — never 0, because the log of it is taken below.</summary>
    private double Uniform()
    {
        _state ^= _state >> 12;
        _state ^= _state << 25;
        _state ^= _state >> 27;

        var next = unchecked(_state * 2685821657736338717UL);

        return ((next >> 11) + 1) / 9007199254740994.0;
    }

    /// <summary>The next reading of an N(mean, sd) stream.</summary>
    // Box-Muller makes two at a time and the second is kept rather than thrown away: half the
    // logarithms and half the sines for the same stream, which matters at a hundred and eighty
    // thousand readings.
    public double Next()
    {
        if (_spare is { } kept)
        {
            _spare = null;
            return _mean + _sd * kept;
        }

        var radius = Math.Sqrt(-2 * Math.Log(Uniform()));
        var angle = 2 * Math.PI * Uniform();

        _spare = radius * Math.Sin(angle);

        return _mean + _sd * radius * Math.Cos(angle);
    }

    /// <summary>A reading of a flat stream between two ends, from the same seed.</summary>
    public double Flat(double low, double high) => low + (high - low) * Uniform();
}

internal static class Streams
{
    /// <summary>Readings evenly spaced in time, and every alert they raised.</summary>
    public static Fed Feed(AlertEngineCore core, IEnumerable<double> values, DateTimeOffset from,
                           TimeSpan every, string topic = AlertEngineFixture.Topic)
        => Feed(core, values.Select(value => (value, every)), from, topic);

    /// <summary>Readings with their own gaps: what a signal does between two readings is data.</summary>
    public static Fed Feed(AlertEngineCore core, IEnumerable<(double Value, TimeSpan Wait)> readings,
                           DateTimeOffset from, string topic = AlertEngineFixture.Topic)
    {
        var raised = new List<Alert>();
        var at = from;

        foreach (var (value, wait) in readings)
        {
            var payload = value.ToString("R", CultureInfo.InvariantCulture);

            raised.AddRange(core.OnMessage(AlertEngineFixture.Message(payload, at, topic), at).Raised);
            at += wait;
        }

        return new Fed(raised, at);
    }

    /// <summary>
    /// A train that rests at nought and goes to five for two readings out of every
    /// <paramref name="period"/>.
    /// </summary>
    public static IEnumerable<double> Train(int readings, int period)
    {
        for (var i = 0; i < readings; i++) yield return i % period < 2 ? 5 : 0;
    }
}
