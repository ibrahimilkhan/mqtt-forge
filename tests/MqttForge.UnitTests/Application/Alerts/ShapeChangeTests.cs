using MqttForge.Application.Alerts;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Alerts;

/// <summary>
/// A signal that stops being the kind of thing it was.
///
/// The same machine as the distribution, on the other half of the note: a quantity that becomes
/// a switch, or a switch that becomes a pulse train, is a machine somebody changed. The test that
/// matters is the negative one — one wild reading in a clean run must not be a change of shape,
/// on the way in or on the way out — because that reading arrives on every sensor in the plant
/// eventually, twice: once when it lands and once when it falls out of the far end of the window.
/// </summary>
public class ShapeChangeTests
{
    private static AlertEngineCore Core(int window = 200) =>
        AlertEngineFixture.Core(AlertEngineFixture.Rule(new ShapeChangeCondition(window)));

    [Fact]
    public void One_bad_reading_in_a_clean_run_is_not_a_change_of_shape()
    {
        var core = Core();
        var bell = new Bell(5150, 20, 2);

        var settled = Streams.Feed(core, Enumerable.Range(0, 400).Select(_ => bell.Next()),
                                   AlertEngineFixture.T0, TimeSpan.FromSeconds(1));

        var spike = Streams.Feed(core, [500d], settled.At, TimeSpan.FromSeconds(1));

        // Three windows: long enough for the bad reading to be judged, and then to be gone.
        var after = Streams.Feed(core, Enumerable.Range(0, 600).Select(_ => bell.Next()),
                                 spike.At, TimeSpan.FromSeconds(1));

        Assert.Empty(settled.Raised);
        Assert.Empty(spike.Raised);
        Assert.Empty(after.Raised);
    }

    // And the rule does fire when the thing really is a different thing. A quantity with noise on
    // it becomes a two-level switch: the mean of the second half describes nothing that happened,
    // which is the whole reason the shape is reported separately from the numbers.
    [Fact]
    public void A_quantity_that_becomes_a_switch_says_so_once()
    {
        var core = Core();
        var bell = new Bell(64, 20, 2);

        var settled = Streams.Feed(core, Enumerable.Range(0, 400).Select(_ => bell.Next()),
                                   AlertEngineFixture.T0, TimeSpan.FromSeconds(1));

        // Five readings at each level, back and forth: two levels, both lived in, crossed often.
        var switched = Streams.Feed(core, Enumerable.Range(0, 400).Select(i => i / 5 % 2 == 0 ? 0d : 1d),
                                    settled.At, TimeSpan.FromSeconds(1));

        Assert.Empty(settled.Raised);
        Assert.Single(switched.Raised);
    }
}
