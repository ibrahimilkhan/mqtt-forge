using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Primitives;
using MqttForge.Api;
using Xunit;

namespace MqttForge.UnitTests.Api;

/// <summary>
/// A page on another origin may not change anything here or open the hub. The browser says where a
/// request came from in two headers no page can set for itself, Sec-Fetch-Site and Origin, and a
/// request that carries neither is not a page's at all.
/// </summary>
public class OriginGuardTests
{
    private const string Inject = "/api/flows/boiler/nodes/press/inject";

    private static readonly Func<string, bool> Nobody = _ => false;

    // The CORS policy's word in Development: the Vite dev server's page.
    private static readonly Func<string, bool> DevServer = origin => origin == "http://localhost:5173";

    private static HttpRequest Request(
        string method, string path, string? origin = null, string? site = null,
        string host = "127.0.0.1:5169", string scheme = "http")
    {
        var context = new DefaultHttpContext();
        context.Request.Method = method;
        context.Request.Path = path;
        context.Request.Scheme = scheme;
        context.Request.Host = new HostString(host);
        if (origin is not null) context.Request.Headers.Origin = origin;
        if (site is not null) context.Request.Headers[OriginGuard.FetchSite] = site;

        return context.Request;
    }

    // Everything that changes something, and the hub whatever the method: the WebSocket upgrade
    // that hands out every broadcast is a GET.
    [Theory]
    [InlineData("POST", Inject)]
    [InlineData("PUT", "/api/flows/boiler")]
    [InlineData("PATCH", "/api/flows/boiler")]
    [InlineData("DELETE", "/api/connection")]
    [InlineData("POST", "/hubs/mqtt/negotiate")]
    [InlineData("GET", "/hubs/mqtt")]
    // Routing ignores case, so the guard has to.
    [InlineData("GET", "/HUBS/mqtt")]
    public void Refuses_a_page_on_another_site(string method, string path) =>
        Assert.False(OriginGuard.IsAllowed(Request(method, path, "http://evil.example"), Nobody));

    // A read is CORS's to keep: the answer never reaches another origin's page, since nothing here
    // lets it. And a link to the console from anywhere still has to open it.
    [Theory]
    [InlineData("GET", "/api/connection/settings")]
    [InlineData("GET", "/")]
    [InlineData("HEAD", "/api/health")]
    [InlineData("OPTIONS", "/api/flows/boiler")]
    public void Leaves_a_read_to_CORS(string method, string path) =>
        Assert.True(OriginGuard.IsAllowed(Request(method, path, "http://evil.example", "cross-site"), Nobody));

    // Another origin in all but name: another port on the same address, the other scheme, a page
    // with no origin to give (a sandboxed frame, a file), and this app's own address inside
    // something else.
    [Theory]
    [InlineData("http://127.0.0.1:3000")]
    [InlineData("https://127.0.0.1:5169")]
    [InlineData("null")]
    [InlineData("http://127.0.0.1:5169.evil.example")]
    [InlineData("http://evil.example@127.0.0.1:5169")]
    public void Refuses_an_origin_that_is_not_the_address_asked(string origin) =>
        Assert.False(OriginGuard.IsAllowed(Request("POST", Inject, origin), Nobody));

    // A browser sends one Origin, so two are nobody's page, and the first being this app's own
    // vouches for nothing. Python's websocket-client sends exactly this when handed an Origin as a
    // header: its own default first, then the one it was given.
    [Fact]
    public void Refuses_two_origins_even_where_the_first_is_the_address_asked()
    {
        var request = Request("GET", "/hubs/mqtt");
        request.Headers.Origin = new StringValues(new[] { "http://127.0.0.1:5169", "http://evil.example" });

        Assert.False(OriginGuard.IsAllowed(request, Nobody));
    }

    // A browser that says the request came from elsewhere is believed, even naming no origin, and
    // even naming this one.
    [Theory]
    [InlineData("cross-site", null)]
    [InlineData("same-site", null)]
    [InlineData("same-site", "http://127.0.0.1:3000")]
    [InlineData("cross-site", "http://127.0.0.1:5169")]
    public void Refuses_a_browser_that_says_another_page_sent_it(string site, string? origin) =>
        Assert.False(OriginGuard.IsAllowed(Request("POST", Inject, origin, site), Nobody));

    // Every route to the app a browser takes: the console on loopback, the desktop window on its LAN
    // address, the container published on localhost, IPv6, a Bonjour name — and port 80, which
    // neither header names. A browser that sends Origin but no Sec-Fetch-Site is decided here.
    [Theory]
    [InlineData("127.0.0.1:5169", "http://127.0.0.1:5169")]
    [InlineData("192.168.1.24:5170", "http://192.168.1.24:5170")]
    [InlineData("localhost:5169", "http://localhost:5169")]
    [InlineData("[::1]:5169", "http://[::1]:5169")]
    [InlineData("kitchen-pi.local:5169", "http://kitchen-pi.local:5169")]
    [InlineData("localhost", "http://localhost")]
    public void Takes_a_page_whose_origin_is_the_address_asked(string host, string origin)
    {
        Assert.True(OriginGuard.IsAllowed(Request("POST", Inject, origin, host: host), Nobody));
        Assert.True(OriginGuard.IsAllowed(Request("GET", "/hubs/mqtt", origin, host: host), Nobody));
    }

    // Behind a proxy that says so, the request is https, and so is the page.
    [Fact]
    public void Takes_a_page_on_https_where_the_request_is() =>
        Assert.True(OriginGuard.IsAllowed(
            Request("POST", Inject, "https://mqtt.example.com", host: "mqtt.example.com", scheme: "https"), Nobody));

    // The browser's own word. Here Origin names the dev server and Host the API, because a proxy
    // in front rewrote Host — Vite's does, for /api. 'none' is the reader's own doing.
    [Theory]
    [InlineData("same-origin")]
    [InlineData("none")]
    public void Takes_the_browsers_word_that_the_page_is_the_addresses_own(string site) =>
        Assert.True(OriginGuard.IsAllowed(
            Request("POST", Inject, "http://localhost:5173", site, host: "localhost:5169"), Nobody));

    // curl, a script, the .NET client: not a browser, so not a page anyone else put in front of the
    // reader. A browser too old to send either header looks the same.
    [Theory]
    [InlineData("POST", Inject)]
    [InlineData("GET", "/hubs/mqtt")]
    public void Takes_a_request_that_names_no_origin(string method, string path) =>
        Assert.True(OriginGuard.IsAllowed(Request(method, path), Nobody));

    // The dev server is another port, so a browser calls it same-site; the CORS policy names it all
    // the same, and the two agree.
    [Theory]
    [InlineData(null)]
    [InlineData("same-site")]
    public void Takes_an_origin_the_CORS_policy_names(string? site)
    {
        Assert.True(OriginGuard.IsAllowed(
            Request("POST", Inject, "http://localhost:5173", site, host: "localhost:5169"), DevServer));
        Assert.False(OriginGuard.IsAllowed(
            Request("POST", Inject, "http://localhost:5173", site, host: "localhost:5169"), Nobody));
    }

    // ---- the dev server ----

    // Vite serves the console on its port at whatever address it was reached by: localhost, over
    // https once the per-machine certificates are there, and the machine's LAN name or address for
    // a phone off the QR code. Every one of those is an origin on port 5173, and nothing else is.
    [Theory]
    [InlineData("http://localhost:5173", true)]
    [InlineData("https://localhost:5173", true)]
    [InlineData("http://kitchen-pi.local:5173", true)]
    [InlineData("https://192.168.1.24:5173", true)]
    [InlineData("http://[::1]:5173", true)]
    [InlineData("http://localhost:5174", false)]
    [InlineData("http://localhost", false)]
    [InlineData("ws://localhost:5173", false)]
    [InlineData("http://evil@localhost:5173", false)]
    [InlineData("http://localhost:5173/console", false)]
    [InlineData("http://localhost:5173, http://evil.example", false)]
    [InlineData("null", false)]
    public void Knows_the_dev_servers_pages_by_their_port(string origin, bool devServer) =>
        Assert.Equal(devServer, OriginGuard.IsDevServer(origin));

    // And by where it is: this machine or its network, which is every address the dev server
    // advertises — localhost, the machine's .local name, its private LAN addresses. Port 5173 is
    // nobody's to own, and a page on it at any other site is another site's page. A source build run
    // with 'dotnet run' is a development run, so this is what stands between it and such a page.
    [Theory]
    [InlineData("http://dev.localhost:5173", true)]
    [InlineData("http://127.0.0.2:5173", true)]
    [InlineData("http://10.0.0.7:5173", true)]
    [InlineData("http://172.16.4.2:5173", true)]
    [InlineData("http://172.31.255.1:5173", true)]
    [InlineData("https://169.254.10.1:5173", true)]
    [InlineData("http://[fd12:3456::1]:5173", true)]
    [InlineData("http://[fe80::1]:5173", true)]
    [InlineData("http://evil.example:5173", false)]
    [InlineData("https://kitchen-pi.local.evil.example:5173", false)]
    [InlineData("http://203.0.113.9:5173", false)]
    [InlineData("http://172.32.0.1:5173", false)]
    [InlineData("http://[2001:db8::1]:5173", false)]
    [InlineData("http://[::ffff:203.0.113.9]:5173", false)]
    public void Knows_the_dev_servers_pages_only_on_this_machine_or_its_network(string origin, bool devServer) =>
        Assert.Equal(devServer, OriginGuard.IsDevServer(origin));

    // ---- refused for the scheme alone ----

    // Behind a proxy that ends TLS the page is https and this app sees http. A WebSocket upgrade
    // carries no Sec-Fetch-Site, so its Origin decides, and it names this very address but for the
    // scheme: refused, rightly, and the one refusal worth a line in the log.
    [Theory]
    [InlineData("https://mqtt.example.com", "mqtt.example.com", "http", true)]
    [InlineData("https://127.0.0.1:5169", "127.0.0.1:5169", "http", true)]
    [InlineData("http://mqtt.example.com", "mqtt.example.com", "https", true)]
    [InlineData("HTTPS://MQTT.example.com", "mqtt.example.com", "http", true)]
    [InlineData("http://evil.example", "127.0.0.1:5169", "http", false)]
    [InlineData("https://evil.example", "127.0.0.1:5169", "http", false)]
    [InlineData("https://mqtt.example.com:8443", "mqtt.example.com", "http", false)]
    [InlineData("http://127.0.0.1:5169", "127.0.0.1:5169", "http", false)]
    [InlineData("null", "127.0.0.1:5169", "http", false)]
    public void Knows_a_page_that_is_this_address_but_for_the_scheme(string origin, string host, string scheme, bool only) =>
        Assert.Equal(only, OriginGuard.OnlySchemeDiffers(Request("GET", "/hubs/mqtt", origin, host: host, scheme: scheme)));

    [Fact]
    public void Says_once_for_each_origin_refused_for_its_scheme_alone_and_nothing_for_another_site()
    {
        var log = new RecordingLogger<OriginGuardLog>();
        var guard = new OriginGuardLog(log);

        guard.Refused(Request("GET", "/hubs/mqtt", "https://mqtt.example.com", host: "mqtt.example.com"));
        guard.Refused(Request("GET", "/hubs/mqtt", "https://mqtt.example.com", host: "mqtt.example.com"));
        guard.Refused(Request("POST", Inject, "http://evil.example"));

        var said = Assert.Single(log.Entries);
        Assert.Equal(Microsoft.Extensions.Logging.LogLevel.Warning, said.Level);
        Assert.Equal(
            "Refused a request from the page at https://mqtt.example.com, which is this app's own address but for the scheme: " +
            "the app sees http. Behind a proxy that ends TLS, keep the Host header and tell the app the scheme " +
            "(ASPNETCORE_FORWARDEDHEADERS_ENABLED=true), or the console's live channel is refused its WebSocket " +
            "and falls back to a stream the proxy may hold back.",
            said.Message);
    }

    // The origins come from requests, so what is remembered of them is bounded: past it, nothing
    // more is said, and by then the log has said it plenty.
    [Fact]
    public void Says_it_for_so_many_origins_and_then_no_more()
    {
        var log = new RecordingLogger<OriginGuardLog>();
        var guard = new OriginGuardLog(log);

        for (var i = 0; i < OriginGuardLog.Origins + 5; i++)
            guard.Refused(Request("GET", "/hubs/mqtt", $"https://10.0.0.{i}:5169", host: $"10.0.0.{i}:5169"));

        Assert.Equal(OriginGuardLog.Origins, log.Entries.Count);
    }
}
