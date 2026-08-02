using System.Net;
using MQFaker.Desktop;

namespace MQFaker.UnitTests.Desktop;

public sealed class LanAddressTests
{
    private static readonly IPAddress Loopback = IPAddress.Parse("127.0.0.1");
    private static readonly IPAddress LinkLocal = IPAddress.Parse("169.254.1.2");
    private static readonly IPAddress Lan = IPAddress.Parse("192.168.1.42");
    private static readonly IPAddress OtherLan = IPAddress.Parse("10.0.0.7");
    private static readonly IPAddress Ipv6Lan = IPAddress.Parse("fe80::1");

    [Fact]
    public void Picks_the_first_usable_candidate()
    {
        var chosen = LanAddress.Choose([Lan, OtherLan]);

        Assert.Equal(Lan, chosen);
    }

    [Fact]
    public void Falls_back_to_loopback_when_there_are_no_candidates()
    {
        var chosen = LanAddress.Choose([]);

        Assert.Equal(IPAddress.Loopback, chosen);
    }

    [Fact]
    public void Falls_back_to_loopback_when_every_candidate_is_unusable()
    {
        // Only loopback and link-local addresses on offer - nothing another device could
        // actually reach, which is exactly the "no LAN address" case the fallback exists for.
        var chosen = LanAddress.Choose([Loopback, LinkLocal, Ipv6Lan]);

        Assert.Equal(IPAddress.Loopback, chosen);
    }

    [Fact]
    public void Skips_a_link_local_address_in_favour_of_a_real_one()
    {
        // Link-local addresses are assigned by the OS itself when DHCP fails; a device on the
        // network cannot route to one, so it must not win just because it enumerated first.
        var chosen = LanAddress.Choose([LinkLocal, Lan]);

        Assert.Equal(Lan, chosen);
    }

    [Fact]
    public void Skips_loopback_when_a_real_candidate_is_also_present()
    {
        var chosen = LanAddress.Choose([Loopback, Lan]);

        Assert.Equal(Lan, chosen);
    }

    [Fact]
    public void Ignores_ipv6_candidates()
    {
        // The window is loaded via a plain "http://{host}:{port}" URI; an IPv6 literal needs
        // bracket syntax to be valid there, which the caller does not add. Restricting to IPv4
        // keeps the produced URI valid without extra formatting logic.
        var chosen = LanAddress.Choose([Ipv6Lan]);

        Assert.Equal(IPAddress.Loopback, chosen);
    }
}
