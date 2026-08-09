using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace MqttForge.Desktop;

// The Mobile panel's QR check relies solely on window.location; "localhost" would fail it
// even when the host is really reachable over the LAN
public static class LanAddress
{
    // Interface type needed alongside the address to tell a real adapter from a tunnel
    public readonly record struct LanCandidate(IPAddress Address, NetworkInterfaceType InterfaceType);

    // Ranks (doesn't exclude) genuine adapters ahead of tunnels: a VPN can be the only real
    // route, and interface enumeration order isn't guaranteed (the original bug here)
    public static IPAddress Choose(IReadOnlyList<LanCandidate> candidates) =>
        candidates
            .Where(c => IsUsable(c.Address))
            .OrderByDescending(c => IsGenuineLocalAdapter(c.InterfaceType))
            .Select(c => c.Address)
            .FirstOrDefault() ?? IPAddress.Loopback;

    // Loopback fallback isn't an error path — the expected outcome on an offline machine
    public static IPAddress ChooseForThisMachine() => Choose(EnumerateCandidates());

    private static bool IsGenuineLocalAdapter(NetworkInterfaceType type) =>
        type is NetworkInterfaceType.Ethernet or NetworkInterfaceType.Wireless80211;

    private static bool IsUsable(IPAddress address) =>
        address.AddressFamily == AddressFamily.InterNetwork &&
        !IPAddress.IsLoopback(address) &&
        !IsLinkLocal(address);

    // 169.254.0.0/16: OS-assigned when DHCP fails, not routable by other devices
    private static bool IsLinkLocal(IPAddress address)
    {
        var bytes = address.GetAddressBytes();
        return bytes[0] == 169 && bytes[1] == 254;
    }

    // Thin I/O layer, deliberately untested directly; Choose() above is what's tested
    private static IReadOnlyList<LanCandidate> EnumerateCandidates() =>
        NetworkInterface.GetAllNetworkInterfaces()
            .Where(nic => nic.OperationalStatus == OperationalStatus.Up)
            .Where(nic => nic.NetworkInterfaceType != NetworkInterfaceType.Loopback)
            .SelectMany(nic => nic.GetIPProperties().UnicastAddresses
                .Select(addr => new LanCandidate(addr.Address, nic.NetworkInterfaceType)))
            .ToList();
}
