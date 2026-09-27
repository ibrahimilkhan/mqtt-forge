using System.Net;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using MqttForge.Api;
using MqttForge.Api.Controllers;
using MqttForge.Application.Flows;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

// The flows PUT reads no more than the largest flow the compiler accepts needs. Only Kestrel holds a
// request to a size: TestServer, which MqttForgeApiFactory runs on, has no such feature and lets any
// body through, so this host is a real one, on a port of its own.
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

        foreach (var path in _files)
            if (File.Exists(path)) File.Delete(path);
    }

    private static HttpRequestMessage Put(string id, byte[] body) => new(HttpMethod.Put, $"/api/flows/{id}")
    {
        Content = new ByteArrayContent(body) { Headers = { { "Content-Type", "application/json" } } },
        // Asked before the body is sent, so the refusal comes back as an answer rather than as a
        // connection the server closed while the client was still writing sixteen megabytes into it.
        Headers = { ExpectContinue = true },
    };

    [Fact]
    public async Task A_body_past_the_limit_is_refused_before_it_is_read()
    {
        var payload = new string('x', (int)FlowController.DeployBodyBytes);
        var body = JsonSerializer.SerializeToUtf8Bytes(new
        {
            id = "huge",
            name = "Huge",
            enabled = true,
            nodes = new[] { new { id = "go", type = "inject", x = 0, y = 0, config = new { payload } } },
            edges = Array.Empty<object>(),
        }, AsTheConsoleWrites);

        using var response = await _client!.SendAsync(Put("huge", body));

        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
    }

    // The limit's own arithmetic, sent: every node at its largest — a 64 KiB payload with a fifth of
    // it quotes, each two bytes on the wire, and a 1,024-character topic of three-byte characters —
    // two hundred of them, and nearly four hundred wires. If this does not fit, the limit refuses a
    // flow the compiler would have run.
    [Fact]
    public async Task The_largest_flow_the_compiler_accepts_fits()
    {
        var payload = string.Create(FlowLimits.PayloadBytes, 0, (chars, _) =>
        {
            for (var i = 0; i < chars.Length; i++) chars[i] = i % 5 == 0 ? '"' : 'x';
        });
        var topic = new string('€', FlowLimits.TopicTemplateLength);

        var nodes = new List<object>();
        var edges = new List<object>();

        for (var i = 0; i < 2; i++)
            nodes.Add(new { id = $"go{i}", type = "inject", x = 0, y = 0, config = new { topic, payload } });

        for (var j = 0; j < FlowLimits.NodesPerFlow - 2; j++)
        {
            nodes.Add(new { id = $"send{j}", type = "publish", x = 0, y = 0, config = new { topic, payload, qos = 2, retain = true } });
            for (var i = 0; i < 2; i++)
                edges.Add(new { id = $"e{edges.Count}", from = $"go{i}", fromPort = "out", to = $"send{j}", toPort = "in" });
        }

        var body = JsonSerializer.SerializeToUtf8Bytes(
            new { id = "largest", name = "Largest", enabled = false, nodes, edges }, AsTheConsoleWrites);

        // Near the limit, or this proves nothing about it.
        Assert.InRange(body.Length, FlowController.DeployBodyBytes * 9 / 10, FlowController.DeployBodyBytes);

        using var response = await _client!.SendAsync(Put("largest", body));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }
}
