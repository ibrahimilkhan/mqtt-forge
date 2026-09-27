using System.Net;
using System.Net.Sockets;

namespace MqttForge.Api;

/// <summary>
/// Which <c>Host</c> headers this server will answer to.
/// </summary>
/// <remarks>
/// The app has no authentication and binds <c>0.0.0.0</c> on purpose — that is what lets the QR
/// panel open it on a phone — and SECURITY.md says so: anyone who can reach the port can drive it.
/// The README's way out of that is to publish the port on loopback, and without this guard that
/// way out does not hold.
/// <para>
/// DNS rebinding is why. A page served from <c>http://evil.example:5169</c> has that as its
/// origin; the attacker then re-resolves their own name to <c>127.0.0.1</c>, and the page's next
/// fetch to <c>http://evil.example:5169/api/connection</c> is same-origin as far as the browser is
/// concerned — no CORS check, and the answer is readable. It reaches a server bound to loopback
/// alone, from anyone on the internet who can get that page in front of the reader. Measured
/// against nothing but the <c>Host</c> header, which is the only part of the request that still
/// carries the name.
/// </para>
/// <para>
/// So a name is refused and an address is not. Rebinding needs a name to move; an IP literal has
/// nothing to re-resolve, and every documented way of reaching this app uses one or uses
/// localhost. Names ending <c>.local</c> are kept because they are mDNS rather than DNS —
/// answered on the link, not by a resolver the attacker can point anywhere — and because reaching
/// a machine by its Bonjour name is ordinary on macOS and Linux.
/// </para>
/// <para>
/// Anyone who does want to answer to a real name — behind a reverse proxy, say — says so by
/// setting <c>AllowedHosts</c>, which stands this down and hands the question to ASP.NET's own
/// host filtering. See <see cref="MqttForgeHost.Build"/>.
/// </para>
/// </remarks>
public static class HostGuard
{
    /// <param name="host">
    /// The name alone, as <c>HttpRequest.Host.Host</c> gives it: no port, and no brackets round an
    /// IPv6 address.
    /// </param>
    public static bool IsAllowed(string? host)
    {
        // Nothing to rebind. An absent Host is HTTP/1.0 or a probe that never named anything.
        if (string.IsNullOrEmpty(host)) return true;

        // An address, v4 or v6. This is what every documented route to the app sends.
        if (IPAddress.TryParse(host, out _)) return true;

        return IsLocalName(host);
    }

    /// <summary>
    /// Whether a host is this machine or the network it is on: the names <see cref="IsAllowed"/>
    /// takes, and a loopback, link-local or private address, but no other address.
    /// </summary>
    /// <remarks>
    /// Every address the Vite dev server advertises, and so every address a development run takes
    /// its pages from: see OriginGuard.IsDevServer. Narrower than IsAllowed on addresses, because the
    /// question there is whether a name can be moved, and here whose page it is: a page served at a
    /// public address is somebody else's, whatever port it is on.
    /// </remarks>
    /// <param name="host">The name alone, as for IsAllowed.</param>
    public static bool IsOnThisNetwork(string host) =>
        IPAddress.TryParse(host, out var address) ? IsPrivate(address) : IsLocalName(host);

    private static bool IsLocalName(string host) =>
        Is(host, "localhost")
        || EndsWith(host, ".localhost")
        // mDNS, so the name is answered on the link rather than by a resolver a stranger can
        // aim. Reaching this machine as 'kitchen-pi.local' is the ordinary case it protects.
        || EndsWith(host, ".local");

    // Loopback, link-local and private, v4 and v6: 127/8, 169.254/16, 10/8, 172.16/12, 192.168/16,
    // and ::1, fe80::/10, fc00::/7. An IPv4 address written as IPv6 is judged as the IPv4 one it is.
    private static bool IsPrivate(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        if (IPAddress.IsLoopback(address)) return true;

        if (address.AddressFamily == AddressFamily.InterNetworkV6)
            return address.IsIPv6LinkLocal || address.IsIPv6UniqueLocal;

        var bytes = address.GetAddressBytes();

        return bytes[0] == 10
            || (bytes[0] == 172 && (bytes[1] & 0xF0) == 16)
            || (bytes[0] == 192 && bytes[1] == 168)
            || (bytes[0] == 169 && bytes[1] == 254);
    }

    private static bool Is(string host, string name) =>
        host.Equals(name, StringComparison.OrdinalIgnoreCase);

    private static bool EndsWith(string host, string suffix) =>
        host.EndsWith(suffix, StringComparison.OrdinalIgnoreCase);
}
