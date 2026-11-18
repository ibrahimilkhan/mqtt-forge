using MqttForge.Infrastructure.Mqtt;
using Xunit;

namespace MqttForge.UnitTests.Infrastructure;

public class InboundTrafficTests
{
    private static readonly DateTimeOffset Noon = new(2026, 11, 17, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void A_link_that_has_heard_nothing_reads_as_silent()
    {
        var traffic = new InboundTraffic();
        traffic.Restart(Noon);

        var reading = traffic.Read(Noon.AddSeconds(30));

        Assert.Equal(0, reading.MessagesPerSecond);
        Assert.Null(reading.SinceLastMessage);
    }

    [Fact]
    public void The_rate_is_taken_over_the_last_ten_seconds()
    {
        var traffic = new InboundTraffic();
        traffic.Restart(Noon);

        // Twenty seconds at 100 a second, of 1 KB each; only the last ten count.
        for (var ms = 0; ms < 20_000; ms += 10)
            traffic.Record(Noon.AddMilliseconds(ms), 1024);

        var reading = traffic.Read(Noon.AddSeconds(20));

        Assert.Equal(100, reading.MessagesPerSecond, precision: 0);
        Assert.Equal(100, reading.KilobytesPerSecond, precision: 0);
        Assert.Equal(TimeSpan.FromMilliseconds(10), reading.SinceLastMessage);
    }

    // A drop three seconds into a link is not three seconds out of ten: dividing by the window
    // would put a broker sending 300 a second down as sending 90.
    [Fact]
    public void A_link_younger_than_the_window_is_measured_over_its_own_age()
    {
        var traffic = new InboundTraffic();
        traffic.Restart(Noon);

        for (var ms = 0; ms < 3_000; ms += 10)
            traffic.Record(Noon.AddMilliseconds(ms), 100);

        Assert.Equal(100, traffic.Read(Noon.AddSeconds(3)).MessagesPerSecond, precision: 0);
    }

    [Fact]
    public void Messages_older_than_the_window_are_not_counted()
    {
        var traffic = new InboundTraffic();
        traffic.Restart(Noon);

        for (var ms = 0; ms < 5_000; ms += 10)
            traffic.Record(Noon.AddMilliseconds(ms), 100);

        var reading = traffic.Read(Noon.AddSeconds(40));

        Assert.Equal(0, reading.MessagesPerSecond);
        Assert.Equal(TimeSpan.FromMilliseconds(35_010), reading.SinceLastMessage);
    }

    [Fact]
    public void A_new_link_starts_from_nothing()
    {
        var traffic = new InboundTraffic();
        traffic.Restart(Noon);
        traffic.Record(Noon.AddSeconds(1), 100);

        traffic.Restart(Noon.AddSeconds(2));

        var reading = traffic.Read(Noon.AddSeconds(3));
        Assert.Equal(0, reading.MessagesPerSecond);
        Assert.Null(reading.SinceLastMessage);
    }
}
