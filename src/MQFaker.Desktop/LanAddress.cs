using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace MQFaker.Desktop;

// The Mobile panel decides whether it can show a QR code purely from window.location (see
// web/src/features/mobile/mobileUrl.ts) - it has no other way to learn whether the page it
// is running on is reachable from a phone. Loading the window at "localhost" would always
// fail that check even though the host really is bound to 0.0.0.0 and reachable over the
// LAN, so the window has to be pointed at an address a phone could actually use in the
// first place.
public static class LanAddress
{
    // Pure: given what the network already reports, decide which one to hand to the window.
    // Kept free of any OS call so "no LAN address" and "several candidates, one of them
    // link-local" are ordinary unit tests instead of things that only reproduce on a
    // particular machine's network setup.
    public static IPAddress Choose(IReadOnlyList<IPAddress> candidates) =>
        candidates.FirstOrDefault(IsUsable) ?? IPAddress.Loopback;

    // The app has to open even on a machine with no network connectivity at all (offline use
    // matters more than the QR code), so falling back to loopback here is not an error path -
    // it is the expected outcome on that machine, and Choose() above is what makes it explicit
    // and testable rather than an accidental side effect of an empty list.
    public static IPAddress ChooseForThisMachine() => Choose(EnumerateCandidates());

    private static bool IsUsable(IPAddress address) =>
        address.AddressFamily == AddressFamily.InterNetwork &&
        !IPAddress.IsLoopback(address) &&
        !IsLinkLocal(address);

    // 169.254.0.0/16: assigned by the OS itself when DHCP fails, not something another device
    // on the network can route to - worth excluding explicitly rather than letting it win by
    // being first in whatever order the OS happens to enumerate interfaces in.
    private static bool IsLinkLocal(IPAddress address)
    {
        var bytes = address.GetAddressBytes();
        return bytes[0] == 169 && bytes[1] == 254;
    }

    // Thin I/O layer: everything that actually asks the OS about interface state lives here,
    // on purpose, so it never needs to be unit-tested directly - Choose() above owns the
    // decision and is what the tests exercise.
    private static IReadOnlyList<IPAddress> EnumerateCandidates() =>
        NetworkInterface.GetAllNetworkInterfaces()
            .Where(nic => nic.OperationalStatus == OperationalStatus.Up)
            .Where(nic => nic.NetworkInterfaceType != NetworkInterfaceType.Loopback)
            .SelectMany(nic => nic.GetIPProperties().UnicastAddresses)
            .Select(addr => addr.Address)
            .ToList();
}
