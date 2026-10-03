using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using Microsoft.AspNetCore.Builder;
using MqttForge.Desktop;

namespace MqttForge.UnitTests.Desktop;

/// <summary>
/// The window's page against a real host, started the way the shell starts it. Whatever is kept
/// from other sites' pages, the page the window loads is this app's own and has to keep working.
/// </summary>
// Every connection is dialled on loopback, but each request names the address the window loads,
// in Host and in Origin, which is all the server has to go on. Loopback because reaching this
// machine's own LAN address can need the local-network permission macOS asks for, and a test run
// has nobody to answer it.
public sealed class DesktopPageOriginTests
{
    // A delete stands for every request that changes something and needs no body to: the kind a page on
    // another site can send without asking first, and the kind the window's own page has to keep.
    [Fact]
    public async Task The_page_in_the_window_can_save_and_delete_a_flow_and_open_the_hub()
    {
        await using var host = await DesktopHost.StartAsync();
        var origin = host.Page.GetLeftPart(UriPartial.Authority);

        var save = await host.SendAsync(HttpMethod.Put, "/api/flows/window", origin, JsonContent.Create(Flow));
        Assert.Equal(HttpStatusCode.OK, save.StatusCode);

        var delete = await host.SendAsync(HttpMethod.Delete, "/api/flows/window", origin);
        Assert.Equal(HttpStatusCode.NoContent, delete.StatusCode);

        using var hub = await host.OpenHubAsync(origin);
        Assert.Equal("{}\u001e", await Handshake(hub));
    }

    [Fact]
    public async Task The_host_behind_the_window_refuses_a_page_on_another_site()
    {
        await using var host = await DesktopHost.StartAsync();

        var save = await host.SendAsync(HttpMethod.Put, "/api/flows/window", origin: null, JsonContent.Create(Flow));
        Assert.Equal(HttpStatusCode.OK, save.StatusCode);

        var delete = await host.SendAsync(HttpMethod.Delete, "/api/flows/window", "http://evil.example");
        Assert.Equal(HttpStatusCode.Forbidden, delete.StatusCode);

        using var hub = new ClientWebSocket();
        hub.Options.CollectHttpResponseDetails = true;
        await Assert.ThrowsAsync<WebSocketException>(() => host.OpenHubAsync("http://evil.example", hub));
        Assert.Equal(HttpStatusCode.Forbidden, hub.HttpStatusCode);
    }

    private static readonly object Flow = new
    {
        id = "window",
        name = "Window",
        enabled = true,
        nodes = new object[]
        {
            new { id = "start", type = "start", x = 40, y = 80, config = new { } },
            new { id = "look", type = "debug", x = 260, y = 80, config = new { } },
            new { id = "end", type = "end", x = 480, y = 80, config = new { } },
        },
        edges = new object[]
        {
            new { id = "e1", from = "start", fromPort = "out", to = "look", toPort = "in" },
            new { id = "e2", from = "look", fromPort = "out", to = "end", toPort = "in" },
        },
    };

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

    /// <summary>The desktop's host on a free port, with every file it keeps in a directory of its own.</summary>
    private sealed class DesktopHost : IAsyncDisposable
    {
        private readonly WebApplication _app;
        private readonly DirectoryInfo _store;
        private readonly SocketsHttpHandler _handler;
        private readonly HttpClient _http;

        private DesktopHost(WebApplication app, DirectoryInfo store, Uri page, int port)
        {
            _app = app;
            _store = store;
            Page = page;
            _handler = OnLoopback(port);
            _http = new HttpClient(_handler, disposeHandler: false) { BaseAddress = page };
        }

        /// <summary>The address the window loads for this host, asked of the same code the shell asks.</summary>
        public Uri Page { get; }

        public static async Task<DesktopHost> StartAsync()
        {
            var store = Directory.CreateTempSubdirectory("mqttforge-desktop-origin-");
            var (app, outcome, port) = await DesktopBind.StartAsync(
                [], Path.Combine(store.FullName, "connection-settings.json"), FreePort());

            return new DesktopHost(app, store, DesktopBind.PageAddress(outcome, port), port);
        }

        public Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, string? origin, HttpContent? content = null)
        {
            var request = new HttpRequestMessage(method, path) { Content = content };
            if (origin is not null) request.Headers.Add("Origin", origin);

            return _http.SendAsync(request);
        }

        public async Task<WebSocket> OpenHubAsync(string origin, ClientWebSocket? socket = null)
        {
            socket ??= new ClientWebSocket();
            socket.Options.SetRequestHeader("Origin", origin);

            var hub = new UriBuilder(Page) { Scheme = "ws", Path = "/hubs/mqtt" }.Uri;
            await socket.ConnectAsync(hub, new HttpMessageInvoker(_handler, disposeHandler: false), CancellationToken.None);

            return socket;
        }

        public async ValueTask DisposeAsync()
        {
            _http.Dispose();
            _handler.Dispose();
            await _app.StopAsync();
            await _app.DisposeAsync();
            _store.Delete(recursive: true);
        }

        // Whatever address a request names, the connection goes to this machine's loopback.
        private static SocketsHttpHandler OnLoopback(int port) => new()
        {
            ConnectCallback = async (_, ct) =>
            {
                var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
                try
                {
                    await socket.ConnectAsync(new IPEndPoint(IPAddress.Loopback, port), ct);
                    return new NetworkStream(socket, ownsSocket: true);
                }
                catch
                {
                    socket.Dispose();
                    throw;
                }
            }
        };

        private static int FreePort()
        {
            using var probe = new TcpListener(IPAddress.Loopback, 0);
            probe.Start();
            return ((IPEndPoint)probe.LocalEndpoint).Port;
        }
    }
}
