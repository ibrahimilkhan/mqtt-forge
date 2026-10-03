using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using MqttForge.Api.Contracts;
using MqttForge.Application.Flows;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Persistence;
using MqttForge.IntegrationTests.Support;
using MQTTnet;
using MQTTnet.Protocol;
using Xunit;

namespace MqttForge.IntegrationTests.Flows;

// Flows against a real broker, with no alert rules at all — so the host being connected is itself
// proof that an enabled flow, or a test, is reason enough to dial. A second, independent client plays
// the plant: it publishes the readings and it is where a flow's publishes are counted.
public sealed class FlowsEndToEndTests : IClassFixture<MosquittoFixture>, IAsyncLifetime
{
    private readonly MosquittoFixture _broker;
    private readonly string _settingsPath = Temp("flow-e2e-settings");
    private readonly string _colourRulesPath = Temp("flow-e2e-colours");
    private readonly string _savedProfilesPath = Temp("flow-e2e-brokers");
    private readonly string _alertRulesPath = Temp("flow-e2e-rules");
    private readonly string _alertStatePath = Temp("flow-e2e-state");
    private readonly string _reconnectPath = Temp("flow-e2e-reconnect");
    private readonly string _flowsPath = Temp("flow-e2e-flows");
    private readonly string _clientId = $"flows-{Guid.NewGuid():N}"[..20];
    private readonly List<WebApplicationFactory<Program>> _hosts = [];

    // What the plant heard, and when by the stopwatch: a flow's pace is the time between two of them.
    private readonly ConcurrentQueue<(string Topic, string Payload, long At)> _heard = new();
    private IMqttClient? _plant;

    public FlowsEndToEndTests(MosquittoFixture broker) => _broker = broker;

    private static string Temp(string what) =>
        Path.Combine(Path.GetTempPath(), $"mqttforge-{what}-{Guid.NewGuid():N}.json");

    public Task InitializeAsync() => Task.CompletedTask;

    public async Task DisposeAsync()
    {
        if (_plant is not null) await _plant.DisconnectAsync();
        _plant?.Dispose();

        // Awaited rather than disposed synchronously, as AlertingEndToEndTests' hosts are: this is
        // what gives the host its shutdown, and AlertEngineHost's handover save runs there.
        foreach (var host in _hosts) await host.DisposeAsync();

        // PointedAt hands back a factory that does not own the files it is handed —
        // AlertingEndToEndTests' reason: a test that restarts "the same" app against files it wrote
        // by hand must not have the second host's dispose delete out from under the first. So every
        // path this class asks PointedAt to use, it also asks for by name, and deletes here itself,
        // with the atomic-write temp file a save called off as its host stopped leaves beside it.
        foreach (var path in new[]
                 {
                     _settingsPath, _colourRulesPath, _savedProfilesPath, _alertRulesPath,
                     _alertStatePath, _reconnectPath, _flowsPath
                 })
        foreach (var file in new[] { path, path + ".tmp" })
            if (File.Exists(file)) File.Delete(file);
    }

    private static JsonElement Config(object config) => JsonSerializer.SerializeToElement(config, FlowJson.Options);

    /// <summary>Forever: read plant/+/temp; over 90, raise Hot and send the fan on; under, clear Hot.</summary>
    private static Flow Watch() => new("watch", "Boiler watch", true,
        [
            new FlowNode("start", "start", 0, 0, Config(new { })),
            new FlowNode("loop", "for", 0, 0, Config(new { forever = true })),
            new FlowNode("in", "mqttIn", 0, 0, Config(new { filter = "plant/+/temp" })),
            new FlowNode("test", "if", 0, 0, Config(new { field = "$.temp", test = "gt", value = "90" })),
            new FlowNode("hot", "alarmRaise", 0, 0, Config(new { name = "Hot", level = "critical", reason = "{{topic[1]}} at {{$.temp}}" })),
            new FlowNode("cool", "alarmClear", 0, 0, Config(new { alarm = "hot" })),
            new FlowNode("fan", "publish", 0, 0, Config(new { topic = "plant/{{topic[1]}}/cmd", payload = "{\"fan\":\"on\"}", qos = 1 })),
            new FlowNode("end", "end", 0, 0, Config(new { })),
        ],
        [
            new FlowEdge("e1", "start", "out", "loop", "in"),
            new FlowEdge("e2", "loop", "body", "in", "in"),
            new FlowEdge("e3", "in", "out", "test", "in"),
            new FlowEdge("e4", "test", "yes", "hot", "in"),
            new FlowEdge("e5", "hot", "raised", "fan", "in"),
            new FlowEdge("e6", "hot", "up", "fan", "in"),
            new FlowEdge("e7", "fan", "out", "loop", "next"),
            new FlowEdge("e8", "test", "no", "cool", "in"),
            new FlowEdge("e9", "cool", "cleared", "loop", "next"),
            new FlowEdge("e10", "cool", "none", "loop", "next"),
            new FlowEdge("e11", "loop", "done", "end", "in"),
        ]);

    // Forever: read loop/x and publish what it read to loop/x — it subscribes to what it publishes.
    // Without the echo guard this would publish for ever.
    private static Flow Loop() => new("loop", "Self loop", true,
        [
            new FlowNode("start", "start", 0, 0, Config(new { })),
            new FlowNode("loop", "for", 0, 0, Config(new { forever = true })),
            new FlowNode("in", "mqttIn", 0, 0, Config(new { filter = "loop/x" })),
            new FlowNode("send", "publish", 0, 0, Config(new { topic = "loop/x", payload = "{{payload}}" })),
            new FlowNode("end", "end", 0, 0, Config(new { })),
        ],
        [
            new FlowEdge("e1", "start", "out", "loop", "in"),
            new FlowEdge("e2", "loop", "body", "in", "in"),
            new FlowEdge("e3", "in", "out", "send", "in"),
            new FlowEdge("e4", "send", "out", "loop", "next"),
            new FlowEdge("e5", "loop", "done", "end", "in"),
        ]);

    /// <summary>Forever: wait a second, then publish the turn's number to sim/tick.</summary>
    // The examples' simulator with its boilers taken out — one message a turn rather than one for each —
    // so all the plant hears is the loop's pace and its count.
    private static Flow Ticker() => new("ticker", "Simulator tick", true,
        [
            new FlowNode("start", "start", 0, 0, Config(new { })),
            new FlowNode("loop", "for", 0, 0, Config(new { forever = true })),
            new FlowNode("pause", "wait", 0, 0, Config(new { seconds = "1" })),
            new FlowNode("tick", "publish", 0, 0, Config(new { topic = "sim/tick", payload = "{{index}}", qos = 1 })),
            new FlowNode("end", "end", 0, 0, Config(new { })),
        ],
        [
            new FlowEdge("e1", "start", "out", "loop", "in"),
            new FlowEdge("e2", "loop", "body", "pause", "in"),
            new FlowEdge("e3", "pause", "out", "tick", "in"),
            new FlowEdge("e4", "tick", "out", "loop", "next"),
            new FlowEdge("e5", "loop", "done", "end", "in"),
        ]);

    /// <summary>Once: read plant/+/temp, and over 90 raise Hot. Either way, End.</summary>
    private static Flow Probe() => new("probe", "Boiler probe", true,
        [
            new FlowNode("start", "start", 0, 0, Config(new { })),
            new FlowNode("in", "mqttIn", 0, 0, Config(new { filter = "plant/+/temp" })),
            new FlowNode("test", "if", 0, 0, Config(new { field = "$.temp", test = "gt", value = "90" })),
            new FlowNode("hot", "alarmRaise", 0, 0, Config(new { name = "Hot", level = "critical", reason = "{{topic[1]}} at {{$.temp}}" })),
            new FlowNode("end", "end", 0, 0, Config(new { })),
        ],
        [
            new FlowEdge("e1", "start", "out", "in", "in"),
            new FlowEdge("e2", "in", "out", "test", "in"),
            new FlowEdge("e3", "test", "yes", "hot", "in"),
            new FlowEdge("e4", "hot", "raised", "end", "in"),
            new FlowEdge("e5", "hot", "up", "end", "in"),
            new FlowEdge("e6", "test", "no", "end", "in"),
        ]);

    private async Task<WebApplicationFactory<Program>> StartedAsync(params Flow[] flows)
    {
        await new JsonConnectionSettingsStore(_settingsPath).SaveAsync(
            new BrokerConnectionSettings(_broker.Host, _broker.Port, _clientId, null, null, false),
            CancellationToken.None);

        var store = new JsonFlowStore(_flowsPath);
        foreach (var flow in flows) await store.SaveAsync(flow, CancellationToken.None);

        var factory = MqttForgeApiFactory.PointedAt(
            _settingsPath, _colourRulesPath, _savedProfilesPath, _alertRulesPath, _alertStatePath,
            _reconnectPath, _flowsPath);
        var host = factory.WithWebHostBuilder(builder => builder.ConfigureAppConfiguration((_, config) =>
            config.AddInMemoryCollection(new Dictionary<string, string?> { ["MqttForge:ConnectOnStart"] = "true" })));

        _hosts.Add(factory);
        _hosts.Add(host);
        _ = host.Services;

        return host;
    }

    /// <summary>The plant, connected, and listening on <paramref name="filter"/> when it is given one.</summary>
    private async Task PlantAsync(string? filter = null)
    {
        _plant = new MqttClientFactory().CreateMqttClient();
        _plant.ApplicationMessageReceivedAsync += e =>
        {
            _heard.Enqueue((e.ApplicationMessage.Topic, e.ApplicationMessage.ConvertPayloadToString() ?? "", Stopwatch.GetTimestamp()));
            return Task.CompletedTask;
        };

        await _plant.ConnectAsync(new MqttClientOptionsBuilder()
            .WithTcpServer(_broker.Host, _broker.Port)
            .WithClientId($"plant-{Guid.NewGuid():N}"[..20])
            .WithCleanSession()
            .Build());

        if (filter is null) return;

        await _plant.SubscribeAsync(new MqttClientSubscribeOptionsBuilder()
            .WithTopicFilter(filter, MqttQualityOfServiceLevel.AtLeastOnce)
            .Build());
    }

    private async Task PublishAsync(string topic, string payload) =>
        await _plant!.PublishStringAsync(topic, payload);

    private static Task Until(Func<bool> settled, string what) => Until(() => Task.FromResult(settled()), what);

    private static async Task Until(Func<Task<bool>> settled, string what)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(20);
        while (DateTime.UtcNow < deadline)
        {
            if (await settled()) return;
            await Task.Delay(50);
        }

        Assert.Fail($"Timed out waiting until {what}.");
    }

    private static Task SubscribedAsync(WebApplicationFactory<Program> host, string filter) =>
        Until(() => host.Services.GetRequiredService<IMqttSubscriber>().Filters.Any(one =>
            one.Filter == filter && one.Owners.HasFlag(SubscriptionOwner.Flows)), $"the flow engine to subscribe {filter}");

    [Fact]
    public async Task A_hot_reading_raises_a_flow_alarm_and_the_flow_publishes_the_fan_command()
    {
        var host = await StartedAsync(Watch());
        await SubscribedAsync(host, "plant/+/temp");
        await PlantAsync("plant/+/cmd");

        await PublishAsync("plant/k1/temp", "{\"temp\":94.2}");

        await Until(() => _heard.Any(one => (one.Topic, one.Payload) == ("plant/k1/cmd", "{\"fan\":\"on\"}")), "the fan command to arrive");

        var client = host.CreateClient();
        await Until(() =>
        {
            var alerts = JsonDocument.Parse(client.GetStringAsync("/api/alerts").GetAwaiter().GetResult()).RootElement;
            return alerts.GetProperty("active").EnumerateArray().Any(alert =>
                alert.GetProperty("ruleId").GetString() == "flow-watch-hot" &&
                alert.GetProperty("reason").GetString() == "k1 at 94.2");
        }, "the flow alarm to be in GET /api/alerts");
    }

    [Fact]
    public async Task A_flow_that_subscribes_to_what_it_publishes_does_not_run_away()
    {
        var host = await StartedAsync(Loop());
        await SubscribedAsync(host, "loop/x");
        await PlantAsync("loop/x");

        await PublishAsync("loop/x", "ping");

        // The plant's own publish, and the flow's one answer to it. The flow's answer comes back to
        // the flow as an echo and is skipped; without that this count climbs until the rate limit.
        await Until(() => _heard.Count >= 2, "the flow to answer once");
        await Task.Delay(TimeSpan.FromSeconds(2));

        Assert.Equal(2, _heard.Count);
    }

    // The simulator the examples ship: a forever loop that publishes on a Wait's pace. An independent
    // subscriber sees its messages arrive about a second apart.
    [Fact]
    public async Task A_forever_loop_with_a_wait_publishes_at_its_pace()
    {
        var host = await StartedAsync();
        var client = host.CreateClient();
        await PlantAsync("sim/tick");

        // Connected first, as a console is before its Activate. The run starts the moment its flow is
        // switched on and publishes a second later, and a host that dialled only because the flow wanted
        // a link would be racing that second: a publish made while the link is down is refused on its
        // node and never sent, and the plant would count from 2.
        var connected = await client.PostAsJsonAsync("/api/connection",
            new ConnectRequestDto(_broker.Host, _broker.Port, _clientId, null, null, false));
        Assert.Equal("Connected", (await connected.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("state").GetString());

        Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync("/api/flows/ticker", Ticker(), FlowJson.Options)).StatusCode);

        await Until(() => _heard.Count >= 3, "the plant to hear three ticks");

        var ticks = _heard.Take(3).ToList();
        Assert.All(ticks, tick => Assert.Equal("sim/tick", tick.Topic));
        Assert.Equal(["1", "2", "3"], ticks.Select(tick => tick.Payload).ToList());

        // A fifth of a second short of the Wait, for the trip each tick makes to the plant: a turn that
        // did not wait its second out would bring them closer than that.
        for (var i = 1; i < ticks.Count; i++)
        {
            var gap = Stopwatch.GetElapsedTime(ticks[i - 1].At, ticks[i].At);
            Assert.True(gap >= TimeSpan.FromSeconds(0.8), $"Tick {i + 1} came {gap.TotalMilliseconds:0} ms after tick {i}.");
        }
    }

    // Test is what the console's button does, and a message published to the broker is how its reader
    // feeds it — here by the plant, from a client of its own.
    [Fact]
    public async Task A_test_reads_the_message_published_to_it_and_raises_its_alarm()
    {
        var host = await StartedAsync();
        var client = host.CreateClient();

        // Nothing in the file is enabled, so the host starts with no link; the test asks for one, as a
        // save does, and reads what arrives once its filter is up at the broker.
        Assert.Equal(HttpStatusCode.Accepted, (await client.PostAsJsonAsync("/api/flows/probe/test", Probe(), FlowJson.Options)).StatusCode);
        await SubscribedAsync(host, "plant/+/temp");

        await PlantAsync();
        await PublishAsync("plant/k9/temp", "{\"temp\":95}");

        async Task<JsonElement?> TestRun() =>
            (await client.GetFromJsonAsync<JsonElement>("/api/flows/status")).GetProperty("runs").EnumerateArray()
                .Where(run => run.GetProperty("flowId").GetString() == "probe" && run.GetProperty("kind").GetString() == "test")
                .Select(run => (JsonElement?)run)
                .FirstOrDefault();

        // The status is what the engine last pushed, a quarter second at most behind, so it is read until
        // the run has ended — and the engine writes down a turn's alarms before it pushes the status that
        // turn left, so by then GET /api/alerts says what became of this one.
        await Until(async () => await TestRun() is { } run && run.GetProperty("state").GetString() is "finished" or "stopped",
            "the test run to end");

        var probe = (await TestRun())!.Value;
        Assert.Equal("finished", probe.GetProperty("state").GetString());
        Assert.Equal("end", probe.GetProperty("at").GetString());

        // Raised and ended by the turn that read the message: the test went on to its End, and a test
        // leaves nothing standing.
        static bool Hot(JsonElement alert) => alert.GetProperty("ruleId").GetString() == "flowtest-probe-hot";

        var alerts = await client.GetFromJsonAsync<JsonElement>("/api/alerts");
        Assert.DoesNotContain(alerts.GetProperty("active").EnumerateArray(), Hot);

        var ended = Assert.Single(alerts.GetProperty("history").EnumerateArray(), Hot);
        Assert.Equal("Boiler probe · Hot (test)", ended.GetProperty("ruleName").GetString());
        Assert.Equal("plant/k9/temp", ended.GetProperty("topic").GetString());
        Assert.Equal("k9 at 95", ended.GetProperty("reason").GetString());
        Assert.Equal("test ended", ended.GetProperty("resolvedBy").GetString());
    }
}
