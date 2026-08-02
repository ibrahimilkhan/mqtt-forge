using System.Net;
using System.Net.NetworkInformation;
using MQFaker.Desktop;
using static MQFaker.Desktop.LanAddress;

namespace MQFaker.UnitTests.Desktop;

public sealed class LanAddressTests
{
    private static readonly IPAddress Loopback = IPAddress.Parse("127.0.0.1");
    private static readonly IPAddress LinkLocal = IPAddress.Parse("169.254.1.2");
    private static readonly IPAddress Lan = IPAddress.Parse("192.168.1.42");
    private static readonly IPAddress OtherLan = IPAddress.Parse("10.0.0.7");
    private static readonly IPAddress Ipv6Lan = IPAddress.Parse("fe80::1");
    private static readonly IPAddress TunnelAddress = IPAddress.Parse("100.64.0.5");

    // Most tests here are not about interface type, so default to a genuine adapter and let
    // the ordering tests below spell out Tunnel/Ppp explicitly.
    private static LanCandidate OnEthernet(IPAddress address) => new(address, NetworkInterfaceType.Ethernet);

    private static LanCandidate OnTunnel(IPAddress address) => new(address, NetworkInterfaceType.Tunnel);

    [Fact]
    public void Picks_the_first_usable_candidate()
    {
        var chosen = Choose([OnEthernet(Lan), OnEthernet(OtherLan)]);

        Assert.Equal(Lan, chosen);
    }

    [Fact]
    public void Falls_back_to_loopback_when_there_are_no_candidates()
    {
        var chosen = Choose([]);

        Assert.Equal(IPAddress.Loopback, chosen);
    }

    [Fact]
    public void Falls_back_to_loopback_when_every_candidate_is_unusable()
    {
        // Only loopback and link-local addresses on offer - nothing another device could
        // actually reach, which is exactly the "no LAN address" case the fallback exists for.
        var chosen = Choose([OnEthernet(Loopback), OnEthernet(LinkLocal), OnEthernet(Ipv6Lan)]);

        Assert.Equal(IPAddress.Loopback, chosen);
    }

    [Fact]
    public void Skips_a_link_local_address_in_favour_of_a_real_one()
    {
        // Link-local addresses are assigned by the OS itself when DHCP fails; a device on the
        // network cannot route to one, so it must not win just because it enumerated first.
        var chosen = Choose([OnEthernet(LinkLocal), OnEthernet(Lan)]);

        Assert.Equal(Lan, chosen);
    }

    [Fact]
    public void Skips_loopback_when_a_real_candidate_is_also_present()
    {
        var chosen = Choose([OnEthernet(Loopback), OnEthernet(Lan)]);

        Assert.Equal(Lan, chosen);
    }

    [Fact]
    public void Ignores_ipv6_candidates()
    {
        // The window is loaded via a plain "http://{host}:{port}" URI; an IPv6 literal needs
        // bracket syntax to be valid there, which the caller does not add. Restricting to IPv4
        // keeps the produced URI valid without extra formatting logic.
        var chosen = Choose([OnEthernet(Ipv6Lan)]);

        Assert.Equal(IPAddress.Loopback, chosen);
    }

    [Fact]
    public void Prefers_a_lan_adapter_over_a_tunnel_when_the_tunnel_enumerates_first()
    {
        // A VPN's utun/Tailscale/WireGuard interface can expose a real, routable address, so
        // enumeration order alone must not decide - the genuine adapter has to win even when
        // the tunnel happens to come first.
        var chosen = Choose([OnTunnel(TunnelAddress), OnEthernet(Lan)]);

        Assert.Equal(Lan, chosen);
    }

    [Fact]
    public void Prefers_a_lan_adapter_over_a_tunnel_when_the_lan_adapter_enumerates_first()
    {
        var chosen = Choose([OnEthernet(Lan), OnTunnel(TunnelAddress)]);

        Assert.Equal(Lan, chosen);
    }

    [Fact]
    public void Falls_back_to_a_tunnel_address_when_it_is_the_only_usable_candidate()
    {
        // A machine connected only through a VPN still needs the app to open at a reachable
        // address; tunnel addresses are ranked last, not excluded, so this stays usable instead
        // of dropping all the way back to loopback.
        var chosen = Choose([OnTunnel(TunnelAddress)]);

        Assert.Equal(TunnelAddress, chosen);
    }
}
