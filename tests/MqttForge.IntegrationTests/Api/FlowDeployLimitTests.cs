using System.Net;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using MqttForge.Api;
using MqttForge.Api.Contracts;
using MqttForge.Api.Controllers;
using MqttForge.Application.Alerts;
using MqttForge.Application.Flows;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

// The flows PUT, and a test's POST, read no more than a flow at every limit needs, written with
// ordinary text. Only Kestrel holds a request to a size: TestServer, which MqttForgeApiFactory runs
// on, has no such feature and lets any body through, so this host is a real one, on a port of its own.
public sealed class FlowDeployLimitTests : IAsyncLifetime
{
    // How the console writes a body: JSON.stringify leaves every character but a quote, a backslash
    // and a control character as it is, and escapes those with a backslash. System.Text.Json's own
    // default would write a quote as six bytes and a euro sign as six more.
    private static readonly JsonSerializerOptions AsTheConsoleWrites = new(JsonSerializerDefaults.Web)
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private readonly List<string> _files = [];
    private WebApplication? _app;
    private HttpClient? _client;

    private string Temp(string what)
    {
        var path = Path.Combine(Path.GetTempPath(), $"mqttforge-deploy-limit-{what}-{Guid.NewGuid():N}.json");
        _files.Add(path);
        return path;
    }

    public async Task InitializeAsync()
    {
        _app = MqttForgeHost.Build(
            [
                $"--MqttForge:SettingsPath={Temp("settings")}",
                $"--MqttForge:ColourRulesPath={Temp("colours")}",
                $"--MqttForge:SavedProfilesPath={Temp("brokers")}",
                $"--MqttForge:AlertRulesPath={Temp("rules")}",
                $"--MqttForge:AlertStatePath={Temp("state")}",
                $"--MqttForge:ReconnectOptionPath={Temp("reconnect")}",
                $"--MqttForge:FlowsPath={Temp("flows")}",
                "--MqttForge:AllowWebhooks=false",
            ],
            urls: "http://127.0.0.1:0");

        await _app.StartAsync();

        var address = _app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();
        _client = new HttpClient { BaseAddress = new Uri(address), Timeout = TimeSpan.FromSeconds(60) };
    }

    public async Task DisposeAsync()
    {
        _client?.Dispose();
        if (_app is not null)
        {
            await _app.StopAsync();
            await _app.DisposeAsync();
        }

        // And each one's atomic-write temp file, which a save called off as the app stopped leaves.
        foreach (var path in _files)
        foreach (var file in new[] { path, path + ".tmp" })
            if (File.Exists(file)) File.Delete(file);
    }

    private static HttpRequestMessage Put(string id, byte[] body) => Send(HttpMethod.Put, $"/api/flows/{id}", body);

    private static HttpRequestMessage Send(HttpMethod method, string path, byte[] body) => new(method, path)
    {
        Content = new ByteArrayContent(body) { Headers = { { "Content-Type", "application/json" } } },
        // Asked before the body is sent, so the refusal comes back as an answer rather than as a
        // connection the server closed while the client was still writing tens of megabytes into it.
        Headers = { ExpectContinue = true },
    };

    // A save, and a test, which sends the same flow as drawn and is held to the same limit for the same
    // reason. This body is past the limit and within Kestrel's own 30 MB, so an action without the limit
    // would read it whole.
    [Theory]
    [InlineData("PUT", "/api/flows/huge")]
    [InlineData("POST", "/api/flows/huge/test")]
    public async Task A_body_past_the_limit_is_refused_before_it_is_read(string method, string path)
    {
        var text = new string('x', (int)FlowController.DeployBodyBytes);
        var body = JsonSerializer.SerializeToUtf8Bytes(new
        {
            id = "huge",
            name = "Huge",
            enabled = true,
            nodes = new[] { new { id = "hook", type = "webhook", x = 0, y = 0, config = new { url = "https://hooks.example.com/x", body = text } } },
            edges = Array.Empty<object>(),
        }, AsTheConsoleWrites);

        using var response = await _client!.SendAsync(Send(new HttpMethod(method), path, body));

        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
    }

    /// <summary>Start → the Webhook nodes given, one after another → End, with the variables given.</summary>
    private static object Chain(string id, IEnumerable<object> configs, IEnumerable<object> variables)
    {
        var nodes = new List<object> { new { id = "start", type = "start", x = 0, y = 0, config = new { } } };
        var edges = new List<object>();
        var previous = "start";

        foreach (var config in configs)
        {
            var hook = $"hook{nodes.Count}";
            nodes.Add(new { id = hook, type = "webhook", x = 0, y = 0, config });
            edges.Add(new { id = $"e{edges.Count}", from = previous, fromPort = "out", to = hook, toPort = "in" });
            previous = hook;
        }

        nodes.Add(new { id = "end", type = "end", x = 0, y = 0, config = new { } });
        edges.Add(new { id = $"e{edges.Count}", from = previous, fromPort = "out", to = "end", toPort = "in" });

        return new { id, name = id, enabled = false, nodes, edges, variables };
    }

    // The limit's own arithmetic, sent: every node at its largest — a Webhook with a 64 KiB body, a fifth
    // of it quotes that are two bytes each on the wire, and a 2,048-character address of three-byte
    // characters after its host — a Start and an End around 198 of them, and fifty variables as large and
    // as quoted. If this does not fit, the limit refuses a flow written the ordinary way.
    [Fact]
    public async Task A_flow_at_every_limit_fits_with_a_fifth_of_each_body_and_value_escaped()
    {
        var text = string.Create(FlowLimits.PayloadBytes, 0, (chars, _) =>
        {
            for (var i = 0; i < chars.Length; i++) chars[i] = i % 5 == 0 ? '"' : 'x';
        });
        const string host = "https://hooks.example.com/";
        var url = host + new string('€', FlowLimits.UrlLength - host.Length);

        var drawn = Chain("largest",
            Enumerable.Repeat<object>(new { url, body = text }, FlowLimits.NodesPerFlow - 2),
            Enumerable.Range(0, FlowLimits.Variables).Select(i => new { name = $"v{i}", value = text }));
        var body = JsonSerializer.SerializeToUtf8Bytes(drawn, AsTheConsoleWrites);

        // Near the limit, or this proves nothing about it.
        Assert.InRange(body.Length, FlowController.DeployBodyBytes * 4 / 5, FlowController.DeployBodyBytes);

        using var response = await _client!.SendAsync(Put("largest", body));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    // What the limit does not hold: a flow heavy in what JSON escapes. A control character is six bytes
    // on the wire, so 198 Webhook bodies of 64 KiB of them — a flow the compiler would run — are past it.
    [Fact]
    public async Task A_flow_the_compiler_would_run_is_refused_unread_when_escaping_takes_it_past_the_limit()
    {
        var text = new string('\u0001', FlowLimits.PayloadBytes);

        var drawn = Chain("escaped",
            Enumerable.Repeat<object>(new { url = "https://hooks.example.com/x", body = text }, FlowLimits.NodesPerFlow - 2),
            []);
        var body = JsonSerializer.SerializeToUtf8Bytes(drawn, AsTheConsoleWrites);

        var flow = JsonSerializer.Deserialize<FlowDto>(body, FlowJson.Options)!.ToFlow();
        Assert.Empty(FlowCompiler.Compile(flow, new AlertEngineOptions().TopicPrefix).Problems);
        Assert.True(body.Length > FlowController.DeployBodyBytes, $"The body is {body.Length} bytes, within the limit.");

        using var response = await _client!.SendAsync(Put("escaped", body));

        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
    }
}
