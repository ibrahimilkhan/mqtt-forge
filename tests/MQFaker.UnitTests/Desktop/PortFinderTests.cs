using System.Net;
using System.Net.Sockets;
using MQFaker.Desktop;

namespace MQFaker.UnitTests.Desktop;

public sealed class PortFinderTests
{
    [Fact]
    public void Returns_the_candidate_when_nothing_holds_it()
    {
        var free = FreePortForTest();

        Assert.Equal(free, PortFinder.FirstFree(free));
    }

    [Fact]
    public void Skips_a_port_that_is_already_held()
    {
        var taken = FreePortForTest();
        using var holder = new TcpListener(IPAddress.Any, taken);
        holder.Start();

        var found = PortFinder.FirstFree(taken);

        Assert.NotEqual(taken, found);
        Assert.True(found > taken);
    }

    [Fact]
    public void Throws_when_the_whole_range_is_held()
    {
        var taken = FreePortForTest();
        using var holder = new TcpListener(IPAddress.Any, taken);
        holder.Start();

        Assert.Throws<IOException>(() => PortFinder.FirstFree(taken, attempts: 1));
    }

    // Asks the OS for a port, then releases it. Racy in principle, fine in practice:
    // the OS hands out ports it is not already using.
    private static int FreePortForTest()
    {
        using var probe = new TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        return ((IPEndPoint)probe.LocalEndpoint).Port;
    }
}
