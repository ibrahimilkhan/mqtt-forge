using System.Net;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using MqttForge.Api;
using MqttForge.IntegrationTests.Support;

namespace MqttForge.IntegrationTests.Api;

/// <summary>
/// The guard against other sites' pages, in the pipeline rather than the rule on its own.
///
/// Any page the reader has open can send requests to an address their browser can reach, and this
/// app's are among them. The browser keeps the answer from the page, but a form or a no-cors fetch
/// sends a POST without asking first, and a WebSocket is not CORS's business at all. Both were
/// measured from <c>http://evil.example</c>: the hub handed that page every broadcast, the reader's
/// broker traffic among them, and a body-less POST pressed a flow's Inject — a node since gone,
/// whose place here a flow's delete takes, the flows' one action that needs no body.
/// </summary>
public sealed class OriginGuardEndpointTests : IClassFixture<MqttForgeApiFactory>
{
    private const string OtherSite = "http://evil.example";

    // TestServer's requests go to http://localhost, so that is where this app's own page is here.
    private const string OwnPage = "http://localhost";

    // The Vite dev server, which CorsPolicyTests pins as the one origin Development lets in.
    private const string DevServer = "http://localhost:5173";

    private readonly MqttForgeApiFactory _factory;
    private readonly HttpClient _client;

    public OriginGuardEndpointTests(MqttForgeApiFactory factory)
    {
        _factory = factory;
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task The_hub_refuses_a_websocket_from_a_page_on_another_site()
    {
        var refused = await Assert.ThrowsAsync<InvalidOperationException>(() => OpenHub(_factory, OtherSite));

        // TestServer's word for an upgrade answered with anything but 101.
        Assert.Contains("status code: 403", refused.Message);
    }

    [Fact]
    public async Task The_hub_refuses_to_negotiate_with_a_page_on_another_site()
    {
        var response = await Send(_client, HttpMethod.Post, "/hubs/mqtt/negotiate?negotiateVersion=1", OtherSite);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    // The console the app serves, and anything that is not a browser at all: curl, a script, the
    // .NET client these tests use elsewhere. Only a page can be made to send a request its reader
    // did not mean, and a program that names no origin can already reach the port itself.
    [Theory]
    [InlineData(OwnPage)]
    [InlineData(null)]
    public async Task The_hub_takes_its_own_page_and_a_client_that_names_no_origin(string? origin)
    {
        var negotiate = await Send(_client, HttpMethod.Post, "/hubs/mqtt/negotiate?negotiateVersion=1", origin);
        Assert.Equal(HttpStatusCode.OK, negotiate.StatusCode);

        using var hub = await OpenHub(_factory, origin);
        Assert.Equal("{}\u001e", await Handshake(hub));
    }

    // The probe's request was a form's: nothing in it, to an action that needs no body to act. A flow's
    // delete needs none either, and is refused before it acts — the flow is still there — while the
    // page's own delete goes through.
    [Fact]
    public async Task A_cross_site_request_does_not_delete_a_flow()
    {
        await Deploy(_client, "buttons");

        var theirs = await Send(_client, HttpMethod.Delete, "/api/flows/buttons", OtherSite);
        Assert.Equal(HttpStatusCode.Forbidden, theirs.StatusCode);
        Assert.True(await Listed(_client, "buttons"));

        var ours = await Send(_client, HttpMethod.Delete, "/api/flows/buttons", OwnPage);
        Assert.Equal(HttpStatusCode.NoContent, ours.StatusCode);
        Assert.False(await Listed(_client, "buttons"));
    }

    [Fact]
    public async Task A_script_that_names_no_origin_still_deletes_a_flow()
    {
        await Deploy(_client, "scripted");

        var response = await Send(_client, HttpMethod.Delete, "/api/flows/scripted", origin: null);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
    }

    // Covered by method rather than one endpoint at a time, so one added later is covered before
    // anybody thinks of it. The body-less POSTs are the ones that were open — a JSON action refuses
    // text/plain with a 415 before it runs — so the list has to hold them, or an enumeration that
    // found nothing would pass.
    [Fact]
    public async Task Every_request_that_changes_something_is_refused_to_a_page_on_another_site()
    {
        // A host of its own: before the guard these requests reached their actions.
        using var fresh = new MqttForgeApiFactory();
        var client = fresh.CreateClient();
        var routes = UnsafeRoutes(fresh.Services);

        Assert.Contains(("POST", "/api/export/folder"), routes);
        Assert.Contains(("POST", "/api/connection/reconnect"), routes);
        Assert.Contains(("POST", "/hubs/mqtt/negotiate"), routes);

        var answered = new List<string>();
        foreach (var (method, path) in routes)
        {
            var response = await Send(client, new HttpMethod(method), path, OtherSite, plainText: true);
            if (response.StatusCode != HttpStatusCode.Forbidden)
                answered.Add($"{method} {path} answered {(int)response.StatusCode}");
        }

        Assert.True(answered.Count == 0, "Answered rather than refused:\n" + string.Join("\n", answered));
    }

    // The desktop window loads the LAN address it bound, or loopback when that bind was refused,
    // so its page names the same host and port in Origin as the request does in Host.
    [Theory]
    [InlineData("192.168.1.24:5170")]
    [InlineData("127.0.0.1:5170")]
    public async Task The_page_in_the_desktop_window_is_its_own_origin(string address)
    {
        await Deploy(_client, "window");

        var delete = await Send(_client, HttpMethod.Delete, "/api/flows/window", $"http://{address}", host: address);
        Assert.Equal(HttpStatusCode.NoContent, delete.StatusCode);

        using var hub = await OpenHub(_factory, $"http://{address}", host: address);
        Assert.Equal("{}\u001e", await Handshake(hub));
    }

    // In development the console is the Vite dev server's page, which proxies /api with the Host
    // rewritten to the API's and /hubs with its own kept. The CORS policy there already names it.
    [Fact]
    public async Task Development_lets_the_dev_servers_page_delete_a_flow_and_open_the_hub()
    {
        using var factory = new MqttForgeApiFactory();
        using var dev = factory.WithWebHostBuilder(b => b.UseEnvironment("Development"));
        var client = dev.CreateClient();
        await Deploy(client, "dev");

        var delete = await Send(client, HttpMethod.Delete, "/api/flows/dev", DevServer, host: "localhost:5169");
        Assert.Equal(HttpStatusCode.NoContent, delete.StatusCode);

        var negotiate = await Send(client, HttpMethod.Post, "/hubs/mqtt/negotiate?negotiateVersion=1", DevServer, host: "localhost:5173");
        Assert.Equal(HttpStatusCode.OK, negotiate.StatusCode);

        using var hub = await OpenHub(dev, DevServer, host: "localhost:5173");
        Assert.Equal("{}\u001e", await Handshake(hub));
    }

    // The dev server as it is really reached. Over https with the per-machine certificates, its
    // /hubs proxy keeps Host and the API sees http, and a WebSocket upgrade carries no Sec-Fetch-
    // Site: Origin decides, and it differs from the address in its scheme. On the LAN, a phone off
    // the QR code is a plain-http page on a name, which sends no Sec-Fetch-Site at all, and /api is
    // proxied with Host rewritten to the API's. Both are the dev server's page on its port.
    [Theory]
    [InlineData("https://localhost:5173")]
    [InlineData("http://kitchen-pi.local:5173")]
    [InlineData("https://192.168.1.24:5173")]
    public async Task Development_takes_the_dev_servers_page_at_the_addresses_it_is_served_from(string page)
    {
        using var factory = new MqttForgeApiFactory();
        using var dev = factory.WithWebHostBuilder(b => b.UseEnvironment("Development"));
        var client = dev.CreateClient();
        await Deploy(client, "lan");

        var delete = await Send(client, HttpMethod.Delete, "/api/flows/lan", page, host: "localhost:5169");
        Assert.Equal(HttpStatusCode.NoContent, delete.StatusCode);

        using var hub = await OpenHub(dev, page, host: new Uri(page).Authority);
        Assert.Equal("{}\u001e", await Handshake(hub));
    }

    // A page on port 5173 of another site is that site's page, development run or not. 'dotnet run'
    // is a development run, so a source build a reader has open is what this keeps such a page from.
    [Theory]
    [InlineData("http://evil.example:5173")]
    [InlineData("https://203.0.113.9:5173")]
    public async Task Development_takes_no_page_on_the_dev_servers_port_at_another_site(string page)
    {
        using var factory = new MqttForgeApiFactory();
        using var dev = factory.WithWebHostBuilder(b => b.UseEnvironment("Development"));
        var client = dev.CreateClient();
        await Deploy(client, "lan");

        var delete = await Send(client, HttpMethod.Delete, "/api/flows/lan", page, host: "localhost:5169");
        Assert.Equal(HttpStatusCode.Forbidden, delete.StatusCode);

        var refused = await Assert.ThrowsAsync<InvalidOperationException>(() => OpenHub(dev, page, host: "localhost:5169"));
        Assert.Contains("status code: 403", refused.Message);
    }

    [Theory]
    [InlineData("https://localhost:5173")]
    [InlineData("http://kitchen-pi.local:5173")]
    public async Task Production_takes_no_dev_server_at_any_address(string page)
    {
        using var factory = new MqttForgeApiFactory();
        using var production = factory.WithWebHostBuilder(b => b.UseEnvironment("Production"));
        var client = production.CreateClient();
        await Deploy(client, "shipped");

        var delete = await Send(client, HttpMethod.Delete, "/api/flows/shipped", page, host: "localhost:5169");
        Assert.Equal(HttpStatusCode.Forbidden, delete.StatusCode);

        var refused = await Assert.ThrowsAsync<InvalidOperationException>(() => OpenHub(production, page, host: "localhost:5169"));
        Assert.Contains("status code: 403", refused.Message);
    }

    // A shipped package serves its console itself, so it has no dev server to trust.
    [Fact]
    public async Task Production_does_not_trust_the_dev_servers_origin()
    {
        using var factory = new MqttForgeApiFactory();
        using var production = factory.WithWebHostBuilder(b => b.UseEnvironment("Production"));
        var client = production.CreateClient();
        await Deploy(client, "shipped");

        var response = await Send(client, HttpMethod.Delete, "/api/flows/shipped", DevServer, host: "localhost:5169");

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    // A browser that says the page is the address's own is believed, whatever Host arrived: a proxy
    // in front — the dev server's, a reverse proxy — may have rewritten Host, and no page can set
    // a Sec- header for itself. Production, so the dev server's origin is trusted for nothing else.
    [Fact]
    public async Task A_browser_that_says_same_origin_is_believed_through_a_proxy_that_rewrote_Host()
    {
        using var factory = new MqttForgeApiFactory();
        using var production = factory.WithWebHostBuilder(b => b.UseEnvironment("Production"));
        var client = production.CreateClient();
        await Deploy(client, "proxied");

        var response = await Send(client, HttpMethod.Delete, "/api/flows/proxied", DevServer,
            host: "localhost:5169", site: "same-origin");

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
    }

    // Naming the hosts hands the Host question to ASP.NET. It does not hand over this one: a page on
    // another site is no more welcome at a name the operator chose than at an address.
    [Fact]
    public async Task Still_refuses_another_site_where_AllowedHosts_names_the_hosts()
    {
        using var factory = new MqttForgeApiFactory();
        using var named = factory.WithWebHostBuilder(b => b.ConfigureAppConfiguration((_, config) =>
            config.AddInMemoryCollection(new Dictionary<string, string?> { ["AllowedHosts"] = "mqtt.example.com" })));
        var client = named.CreateClient();

        var theirs = await Send(client, HttpMethod.Post, "/hubs/mqtt/negotiate?negotiateVersion=1", OtherSite, host: "mqtt.example.com");
        Assert.Equal(HttpStatusCode.Forbidden, theirs.StatusCode);

        var ours = await Send(client, HttpMethod.Post, "/hubs/mqtt/negotiate?negotiateVersion=1", "http://mqtt.example.com", host: "mqtt.example.com");
        Assert.Equal(HttpStatusCode.OK, ours.StatusCode);
    }

    // Behind a proxy that ends TLS the console's page is https and the app sees http. A WebSocket
    // upgrade carries no Sec-Fetch-Site in any browser, so its Origin decides, against an address
    // that is the page's own but for the scheme. Told the scheme by the proxy's header, the app takes
    // the page; not told, it refuses the upgrade, and says why in its log, once.
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task A_websocket_from_a_page_behind_a_proxy_that_ends_TLS_is_taken_once_the_app_is_told_the_scheme(bool told)
    {
        var log = new RecordingLogger<OriginGuardLog>();
        using var factory = new MqttForgeApiFactory();
        using var proxied = factory.WithWebHostBuilder(b =>
        {
            b.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["AllowedHosts"] = "mqtt.example.com",
                // What ASPNETCORE_FORWARDEDHEADERS_ENABLED sets.
                ["FORWARDEDHEADERS_ENABLED"] = told ? "true" : "false",
            }));
            b.ConfigureTestServices(services => services.AddSingleton<ILogger<OriginGuardLog>>(log));
        });

        Task<WebSocket> Upgrade()
        {
            var client = proxied.Server.CreateWebSocketClient();
            client.ConfigureRequest = request =>
            {
                request.Headers.Origin = "https://mqtt.example.com";
                request.Headers["X-Forwarded-Proto"] = "https";
                request.Host = new HostString("mqtt.example.com");
            };

            return client.ConnectAsync(new Uri(proxied.Server.BaseAddress, "hubs/mqtt"), CancellationToken.None);
        }

        if (told)
        {
            using var hub = await Upgrade();
            Assert.Equal("{}\u001e", await Handshake(hub));
            Assert.Empty(log.Entries);
            return;
        }

        Assert.Contains("status code: 403", (await Assert.ThrowsAsync<InvalidOperationException>(Upgrade)).Message);
        Assert.Contains("status code: 403", (await Assert.ThrowsAsync<InvalidOperationException>(Upgrade)).Message);

        var said = Assert.Single(log.Entries);
        Assert.Equal(LogLevel.Warning, said.Level);
        Assert.StartsWith("Refused a request from the page at https://mqtt.example.com,", said.Message);
    }

    private static async Task<HttpResponseMessage> Send(
        HttpClient client, HttpMethod method, string path, string? origin,
        string? host = null, string? site = null, bool plainText = false)
    {
        var request = new HttpRequestMessage(method, path);
        if (origin is not null) request.Headers.Add("Origin", origin);
        if (site is not null) request.Headers.Add("Sec-Fetch-Site", site);
        if (host is not null) request.Headers.Host = host;

        // What a form, or a fetch in no-cors mode, can send without asking first.
        if (plainText) request.Content = new StringContent("", Encoding.UTF8, "text/plain");

        return await client.SendAsync(request);
    }

    /// <summary>The WebSocket upgrade with negotiation skipped, as the probe opened it.</summary>
    private static Task<WebSocket> OpenHub(WebApplicationFactory<Program> factory, string? origin, string? host = null)
    {
        var client = factory.Server.CreateWebSocketClient();
        client.ConfigureRequest = request =>
        {
            if (origin is not null) request.Headers.Origin = origin;
            if (host is not null) request.Host = new HostString(host);
        };

        return client.ConnectAsync(new Uri(factory.Server.BaseAddress, "hubs/mqtt"), CancellationToken.None);
    }

    /// <summary>SignalR's JSON handshake. The hub answers an empty object once it has taken the connection.</summary>
    private static async Task<string> Handshake(WebSocket hub)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var hello = Encoding.UTF8.GetBytes("{\"protocol\":\"json\",\"version\":1}\u001e");
        await hub.SendAsync(new ArraySegment<byte>(hello), WebSocketMessageType.Text, endOfMessage: true, timeout.Token);

        var buffer = new byte[256];
        var received = await hub.ReceiveAsync(new ArraySegment<byte>(buffer), timeout.Token);

        return Encoding.UTF8.GetString(buffer, 0, received.Count);
    }

    /// <summary>Start → Debug → End, saved by a client that names no origin: a flow for a page to delete.</summary>
    private static async Task Deploy(HttpClient client, string id)
    {
        var flow = new
        {
            id,
            name = "Buttons",
            enabled = true,
            nodes = new object[]
            {
                new { id = "start", type = "start", x = 40, y = 100, config = new { } },
                new { id = "look", type = "debug", x = 260, y = 100, config = new { } },
                new { id = "end", type = "end", x = 480, y = 100, config = new { } },
            },
            edges = new object[]
            {
                new { id = "e1", from = "start", fromPort = "out", to = "look", toPort = "in" },
                new { id = "e2", from = "look", fromPort = "out", to = "end", toPort = "in" },
            },
        };

        Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync($"/api/flows/{id}", flow)).StatusCode);
    }

    /// <summary>Whether GET /api/flows still lists the flow.</summary>
    private static async Task<bool> Listed(HttpClient client, string id)
    {
        using var flows = JsonDocument.Parse(await client.GetStringAsync("/api/flows"));

        return flows.RootElement.GetProperty("flows").EnumerateArray().Any(flow => flow.GetProperty("id").GetString() == id);
    }

    /// <summary>Every mapped method that is not GET, HEAD, OPTIONS or TRACE, on a path with its parameters filled.</summary>
    // An endpoint that names no method takes them all. The hub's two are like that: SignalR sorts
    // the methods out itself, once the request has reached it.
    private static IReadOnlyList<(string Method, string Path)> UnsafeRoutes(IServiceProvider services) =>
    [
        .. services.GetRequiredService<EndpointDataSource>().Endpoints
            .OfType<RouteEndpoint>()
            .SelectMany(endpoint => (endpoint.Metadata.GetMetadata<IHttpMethodMetadata>()?.HttpMethods
                                     ?? ["POST", "PUT", "PATCH", "DELETE"])
                .Where(method => !HttpMethods.IsGet(method) && !HttpMethods.IsHead(method)
                                 && !HttpMethods.IsOptions(method) && !HttpMethods.IsTrace(method))
                .Select(method => (method, "/" + Regex.Replace(endpoint.RoutePattern.RawText!.TrimStart('/'), @"\{[^}]*\}", "x"))))
            .Distinct()
    ];
}
