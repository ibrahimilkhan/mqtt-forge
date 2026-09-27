using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
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
// proof that an enabled flow is reason enough to dial. A second, independent client plays the
// plant: it publishes the readings and it is where a flow's publishes are counted.
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
    private readonly ConcurrentQueue<(string Topic, string Payload)> _heard = new();
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

    private static Flow Watch() => new("watch", "Boiler watch", true,
        [
            new FlowNode("in", "mqttIn", 0, 0, Config(new { filter = "plant/+/temp" })),
            new FlowNode("test", "if", 0, 0, Config(new { field = "$.temp", test = "gt", value = "90" })),
            new FlowNode("hot", "alarm", 0, 0, Config(new { name = "Hot", severity = "critical", reason = "{{topic[1]}} at {{$.temp}}" })),
            new FlowNode("fan", "publish", 0, 0, Config(new { topic = "plant/{{topic[1]}}/cmd", payload = "{\"fan\":\"on\"}", qos = 1 })),
        ],
        [
            new FlowEdge("e1", "in", "out", "test", "in"),
            new FlowEdge("e2", "test", "yes", "hot", "raise"),
            new FlowEdge("e3", "test", "yes", "fan", "in"),
            new FlowEdge("e4", "test", "no", "hot", "clear"),
        ]);

    // Subscribes to what it publishes. Without the echo guard this would publish for ever.
    private static Flow Loop() => new("loop", "Self loop", true,
        [
            new FlowNode("in", "mqttIn", 0, 0, Config(new { filter = "loop/x" })),
            new FlowNode("send", "publish", 0, 0, Config(new { topic = "loop/x", payload = "{{payload}}" })),
        ],
        [new FlowEdge("e1", "in", "out", "send", "in")]);

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

    private async Task PlantAsync(string filter)
    {
        _plant = new MqttClientFactory().CreateMqttClient();
        _plant.ApplicationMessageReceivedAsync += e =>
        {
            _heard.Enqueue((e.ApplicationMessage.Topic, e.ApplicationMessage.ConvertPayloadToString() ?? ""));
            return Task.CompletedTask;
        };

        await _plant.ConnectAsync(new MqttClientOptionsBuilder()
            .WithTcpServer(_broker.Host, _broker.Port)
            .WithClientId($"plant-{Guid.NewGuid():N}"[..20])
            .WithCleanSession()
            .Build());
        await _plant.SubscribeAsync(new MqttClientSubscribeOptionsBuilder()
            .WithTopicFilter(filter, MqttQualityOfServiceLevel.AtLeastOnce)
            .Build());
    }

    private async Task PublishAsync(string topic, string payload) =>
        await _plant!.PublishStringAsync(topic, payload);

    private static async Task Until(Func<bool> settled, string what)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(20);
        while (DateTime.UtcNow < deadline)
        {
            if (settled()) return;
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

        await Until(() => _heard.Any(one => one == ("plant/k1/cmd", "{\"fan\":\"on\"}")), "the fan command to arrive");

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
}
