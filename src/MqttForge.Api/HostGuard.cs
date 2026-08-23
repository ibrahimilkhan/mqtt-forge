using System.Net;

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

        return Is(host, "localhost")
            || EndsWith(host, ".localhost")
            // mDNS, so the name is answered on the link rather than by a resolver a stranger can
            // aim. Reaching this machine as 'kitchen-pi.local' is the ordinary case it protects.
            || EndsWith(host, ".local");
    }

    private static bool Is(string host, string name) =>
        host.Equals(name, StringComparison.OrdinalIgnoreCase);

    private static bool EndsWith(string host, string suffix) =>
        host.EndsWith(suffix, StringComparison.OrdinalIgnoreCase);
}
