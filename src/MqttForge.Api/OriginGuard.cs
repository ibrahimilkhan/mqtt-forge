namespace MqttForge.Api;

/// <summary>
/// Which requests a page on another origin may send this server: none that change anything, and
/// none to the hub.
/// </summary>
/// <remarks>
/// Any page the reader has open can send requests to an address their browser can reach, and this
/// app's are among them: 127.0.0.1, the LAN address the desktop window loads, a container
/// published on localhost. The browser keeps the answer from the page, since nothing here lets
/// another origin read one. But a request that changes something has done it before anybody reads
/// the answer, and a form, or a fetch in no-cors mode, sends a POST with a text/plain body and no
/// preflight. A JSON action refuses that body with a 415 before it runs; one that needs no body
/// does not, and pressing a flow's Inject, opening the host's folder dialog and dialling the
/// broker again are all like that. A WebSocket is not CORS's business at all, so a page on any site
/// could open one to the hub and hear every broadcast, the reader's broker traffic among them.
/// <para>
/// So every request that is not GET, HEAD, OPTIONS or TRACE, and every request under /hubs, has to
/// come from this app's own page. A browser says where a request came from in two headers a page
/// cannot set for itself. Sec-Fetch-Site is the browser's own verdict, and every current browser
/// sends it. It is asked first and believed, because the browser knows which address it asked,
/// where this server only has a Host header that a proxy in front may have rewritten. Origin names
/// the page, and decides for a browser too old to send the first: it has to be the scheme, host
/// and port the request was sent to.
/// </para>
/// <para>
/// A request that carries neither is served. It is curl, a script, anything that is not a browser,
/// and those can reach the port themselves, as SECURITY.md says. This is a guard against a page
/// put in front of the reader, and every browser in use names one or the other on the requests it
/// guards — Origin on a WebSocket upgrade from the very start.
/// </para>
/// </remarks>
public static class OriginGuard
{
    /// <summary>Where the browser says the sending page stands to the address it sent to.</summary>
    public const string FetchSite = "Sec-Fetch-Site";

    /// <param name="trusted">
    /// Origins besides the app's own whose pages may send it anyway: those the CORS policy names,
    /// which is the dev server's in Development and nobody's in a shipped package.
    /// </param>
    public static bool IsAllowed(HttpRequest request, Func<string, bool> trusted)
    {
        if (!Guards(request)) return true;

        var site = request.Headers[FetchSite].ToString();
        var origin = request.Headers.Origin.ToString();

        // 'none' is the reader's own doing — the address bar, a bookmark — with no page behind it.
        if (site is "same-origin" or "none") return true;

        // Neither header: not a browser. Sec-Fetch-Site alone: a browser saying another page sent
        // it, without saying which.
        if (origin.Length == 0) return site.Length == 0;

        if (trusted(origin)) return true;

        // Same-site is still another origin: another port on this address is another app.
        if (site.Length > 0) return false;

        // Compared whole rather than parsed, since a browser writes both the same way: the port
        // only when it is not the scheme's own, the host in lower case, an IPv6 one in brackets.
        // Two Origins, which no browser sends, arrive joined and match nothing.
        return string.Equals(
            origin, $"{request.Scheme}://{request.Host.ToUriComponent()}", StringComparison.OrdinalIgnoreCase);
    }

    // Anything but a read, and anything on the hub, whose WebSocket upgrade is a GET. The path is
    // matched as routing matches it, ignoring case.
    private static bool Guards(HttpRequest request) =>
        request.Path.StartsWithSegments("/hubs")
        || !(HttpMethods.IsGet(request.Method) || HttpMethods.IsHead(request.Method)
             || HttpMethods.IsOptions(request.Method) || HttpMethods.IsTrace(request.Method));
}
