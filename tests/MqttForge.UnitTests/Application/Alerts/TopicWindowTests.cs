using MqttForge.Application.Alerts;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Alerts;

public class TopicWindowTests
{
    // A reading a second, from a fixed moment, so a failing assertion names a second rather than
    // a tick count nobody can read. The ticks matter: the ring carries the arrival time as well
    // as the value, and 'pulse' measures its period out of exactly these.
    private static Reading At(int second, double value) =>
        new(DateTimeOffset.UnixEpoch.AddSeconds(second).UtcTicks, value);

    private static TopicWindow Filled(int capacity, int readings)
    {
        var window = new TopicWindow(capacity);
        for (var i = 1; i <= readings; i++) window.Add(At(i, i));

        return window;
    }

    private static double[] ValuesOf(TopicWindow window)
    {
        var values = new double[window.Count];
        Assert.Equal(window.Count, window.CopyValuesTo(values));

        return values;
    }

    [Fact]
    public void A_new_window_is_empty_and_keeps_the_capacity_it_was_given()
    {
        var window = new TopicWindow(200);

        Assert.Equal(200, window.Capacity);
        Assert.Equal(0, window.Count);
    }

    [Fact]
    public void A_window_holds_every_reading_until_it_is_full()
    {
        var window = Filled(capacity: 4, readings: 3);

        Assert.Equal(3, window.Count);
        Assert.Equal([1d, 2d, 3d], ValuesOf(window));
    }

    [Fact]
    public void A_window_never_grows_past_its_capacity()
    {
        var window = Filled(capacity: 4, readings: 400);

        Assert.Equal(4, window.Count);
        Assert.Equal(4, window.Capacity);
    }

    [Fact]
    public void The_oldest_readings_are_the_ones_that_fall_out()
    {
        // Six readings through a ring of four: the wrap has happened, and 1 and 2 are gone.
        var window = Filled(capacity: 4, readings: 6);

        Assert.Equal([3d, 4d, 5d, 6d], ValuesOf(window));
    }

    [Fact]
    public void A_reading_keeps_the_moment_it_arrived_at()
    {
        var window = Filled(capacity: 4, readings: 6);

        var readings = new Reading[4];
        window.CopyTo(readings);

        Assert.Equal(DateTimeOffset.UnixEpoch.AddSeconds(3).UtcTicks, readings[0].Ticks);
        Assert.Equal(DateTimeOffset.UnixEpoch.AddSeconds(6).UtcTicks, readings[3].Ticks);
    }

    [Fact]
    public void Copying_into_a_destination_smaller_than_the_window_keeps_the_newest()
    {
        var window = Filled(capacity: 4, readings: 6);

        var destination = new Reading[2];

        Assert.Equal(2, window.CopyTo(destination));
        Assert.Equal([5d, 6d], destination.Select(reading => reading.Value));
    }

    [Fact]
    public void Copying_values_into_a_destination_smaller_than_the_window_keeps_the_newest()
    {
        var window = Filled(capacity: 4, readings: 6);

        var destination = new double[3];

        Assert.Equal(3, window.CopyValuesTo(destination));
        Assert.Equal([4d, 5d, 6d], destination);
    }

    [Fact]
    public void Copying_into_a_larger_destination_writes_only_what_is_there()
    {
        var window = Filled(capacity: 4, readings: 6);

        var destination = new Reading[6];
        destination[5] = At(99, 99);

        Assert.Equal(4, window.CopyTo(destination));
        Assert.Equal([3d, 4d, 5d, 6d], destination[..4].Select(reading => reading.Value));

        // The tail is the caller's, and a count of four said so. A window that helpfully zeroed
        // it would be a window deciding what a buffer it does not own should say.
        Assert.Equal(99d, destination[5].Value);
    }

    [Fact]
    public void Copying_from_an_empty_window_writes_nothing()
    {
        var window = new TopicWindow(4);

        Assert.Equal(0, window.CopyTo(new Reading[4]));
        Assert.Equal(0, window.CopyValuesTo(new double[4]));
    }

    [Fact]
    public void Copying_into_an_empty_destination_writes_nothing()
    {
        var window = Filled(capacity: 4, readings: 6);

        Assert.Equal(0, window.CopyTo([]));
        Assert.Equal(0, window.CopyValuesTo([]));
    }

    [Fact]
    public void Clear_empties_the_window()
    {
        var window = Filled(capacity: 4, readings: 6);

        window.Clear();

        Assert.Equal(0, window.Count);
        Assert.Equal(4, window.Capacity);
        Assert.Equal(0, window.CopyTo(new Reading[4]));
    }

    [Fact]
    public void A_window_refilled_after_a_clear_starts_again_at_its_first_reading()
    {
        // This is the 'new level accepted' path of the outlier condition: the ring is emptied on
        // purpose and the readings that follow are the new normal. If Clear left the write head
        // where it was, the first reading after it would land in the middle and come back out in
        // the wrong order — with no test between that and a silently wrong Tukey fence.
        var window = Filled(capacity: 4, readings: 6);

        window.Clear();
        window.Add(At(7, 7));
        window.Add(At(8, 8));

        Assert.Equal(2, window.Count);
        Assert.Equal([7d, 8d], ValuesOf(window));
    }

    [Fact]
    public void A_window_of_the_smallest_size_a_rule_may_ask_for_holds_twenty_readings()
    {
        // AlertEngineOptions.MinWindow. Below it a condition never fires, so the boundary is
        // worth pinning: twenty in, twenty out, and the twenty-first pushes the first away.
        var window = Filled(capacity: 20, readings: 25);

        Assert.Equal(20, window.Count);

        var values = ValuesOf(window);
        Assert.Equal(6d, values[0]);
        Assert.Equal(25d, values[19]);
    }

    [Fact]
    public void A_window_of_one_holds_the_newest_reading_only()
    {
        var window = Filled(capacity: 1, readings: 3);

        Assert.Equal(1, window.Count);
        Assert.Equal([3d], ValuesOf(window));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void A_window_with_no_room_in_it_is_refused(int capacity)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new TopicWindow(capacity));
    }
}
