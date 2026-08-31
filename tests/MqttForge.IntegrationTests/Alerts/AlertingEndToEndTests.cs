using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Persistence;
using MqttForge.IntegrationTests.Support;
using MQTTnet;
using MQTTnet.Protocol;
using Xunit;

namespace MqttForge.IntegrationTests.Alerts;

/// <summary>
/// The whole of alerting, in one run: a rules file on disk, a real broker, a message somebody
/// else published, and the three places the alarm comes out.
/// </summary>
// HeadlessAlertingTests proves the engine runs with nobody watching. This proves what happens
// when it fires: an endpoint the operator named gets a POST, the broker gets the alert published
// back onto it, and a console connected to the hub is told. Every one of those is read as the
// bytes that actually went out, because the contract for all three is a shape and not a type.
//
// Nothing stands in for anything. The webhook endpoint is a real Kestrel bound to a loopback port
// this class owns; the broker is a container; the console is a real SignalR client over the test
// server's own handler. The only thing that is not shipped behaviour is the AllowWebhooks switch,
// which the factory turns off for the suite and this class turns back on for itself.
public class AlertingEndToEndTests : IClassFixture<MosquittoFixture>, IAsyncLifetime
{
    private readonly MosquittoFixture _broker;

    private readonly string _settingsPath = Temp("e2e-settings");
    private readonly string _colourRulesPath = Temp("e2e-colours");
    private readonly string _savedProfilesPath = Temp("e2e-brokers");
    private readonly string _alertRulesPath = Temp("e2e-rules");
    private readonly string _alertStatePath = Temp("e2e-state");

    private readonly string _clientId = $"e2e-{Guid.NewGuid():N}"[..23];

    private readonly List<WebApplicationFactory<Program>> _hosts = [];
    private readonly Channel<JsonElement> _raised = Channel.CreateUnbounded<JsonElement>();
    private readonly Channel<(string Topic, string Payload)> _published =
        Channel.CreateUnbounded<(string, string)>();

    private WebhookProbe? _probe;
    private HubConnection? _console;
    private IMqttClient? _listener;
    private IMqttClient? _publisher;

    public AlertingEndToEndTests(MosquittoFixture broker) => _broker = broker;

    private static string Temp(string what) =>
        Path.Combine(Path.GetTempPath(), $"mqttforge-{what}-{Guid.NewGuid():N}.json");

    public Task InitializeAsync() => Task.CompletedTask;

    /// <summary>The rule the file holds: three channels at once, which is the point.</summary>
    // A null Topic on the publish action means the default the spec names — {prefix}{RuleId}/{topic}
    // — so this exercises the path a rule that says nothing about a topic takes, which is the one
    // almost every rule will take.
    private static AlertRule Hot(string url) => new(
        "hot", "Boiler temperature", Enabled: true, "plant/+/temp", Field: null,
        new ThresholdCondition(ThresholdOp.Gt, 90), Clear: null, For: null, Cooldown: null,
        AlertSeverity.Critical,
        [
            new ScreenAction(),
            new WebhookAction(url, new Dictionary<string, string> { ["X-Forge-Plant"] = "boiler-house" }),
            new PublishAction(null, 1, false)
        ]);

    /// <summary>
    /// Everything up and connected, one reading over the line, and nothing asserted yet.
    /// </summary>
    private async Task RingingAsync()
    {
        _probe = await WebhookProbe.StartAsync();

        // Through the real stores. A JSON literal here would pass while the store wrote something
        // else, and the shape of these two files is the contract this run depends on.
        await new JsonConnectionSettingsStore(_settingsPath).SaveAsync(
            new BrokerConnectionSettings(_broker.Host, _broker.Port, _clientId, null, null, false),
            CancellationToken.None);

        await new JsonAlertRuleStore(_alertRulesPath).SaveAsync(
            [Hot(_probe.Url)], CancellationToken.None);

        var host = Started();

        await ListenAsync("mqttforge/alerts/#");
        await ConsoleAsync(host);

        // MQTT keeps nothing for a subscriber that was not there yet, so a message published
        // before the engine's SUBSCRIBE lands is simply gone — and this test would then fail for
        // a reason that has nothing to do with alerting.
        await Until(
            () => host.Services.GetRequiredService<IMqttSubscriber>().Filters,
            filters => filters.Any(filter => filter.Filter == "plant/+/temp"),
            "the engine to subscribe the rule's filter");

        await PublishAsync("plant/boiler/temp", "94.2");
    }

    // The body the spec's "Dışarı giden gövde" section describes, field by field. Read as JSON on
    // purpose: this is the one contract in the app that a person writes an integration against,
    // and a renamed property has to fail here rather than in somebody's Node-RED flow.
    [Fact]
    public async Task The_webhook_body_is_the_one_the_spec_describes()
    {
        await RingingAsync();

        var delivery = await _probe!.NextAsync();
        var body = JsonDocument.Parse(delivery.Body).RootElement;

        Assert.StartsWith("application/json", delivery.ContentType);
        Assert.Equal("raised", body.GetProperty("event").GetString());
        Assert.Equal("hot", body.GetProperty("rule").GetProperty("id").GetString());
        Assert.Equal("Boiler temperature", body.GetProperty("rule").GetProperty("name").GetString());
        Assert.Equal("plant/boiler/temp", body.GetProperty("topic").GetString());
        Assert.Equal("critical", body.GetProperty("severity").GetString());
        Assert.Equal(94.2, body.GetProperty("value").GetDouble());
        Assert.Equal("94.2", body.GetProperty("sample").GetString());
        Assert.Contains("90", body.GetProperty("reason").GetString()!);

        // A moment, not a string that happens to look like one: an endpoint that cannot parse
        // 'at' cannot order two alerts, which is the first thing any receiver does with them.
        Assert.True(DateTimeOffset.TryParse(body.GetProperty("at").GetString(), out _),
            $"'at' was not a moment: {body.GetProperty("at")}");
    }

    // The headers are the reason SECURITY.md has a paragraph about this file. They are the
    // operator's own bearer token as often as not, they are stored in plain text, and they have
    // to arrive — a webhook whose headers were dropped is a webhook every gateway rejects.
    [Fact]
    public async Task The_headers_the_rule_carries_travel_with_it()
    {
        await RingingAsync();

        Assert.Equal("boiler-house", (await _probe!.NextAsync()).Header);
    }

    // The channel that needs no listener of its own: the alert goes back onto the broker, where
    // anything already connected can act on it. The topic is the default the spec names, built
    // from the server's prefix rather than baked into the rules file.
    [Fact]
    public async Task The_alert_is_published_back_to_the_broker_under_the_prefix()
    {
        await RingingAsync();

        var (topic, payload) = await NextPublishedAsync();

        Assert.Equal("mqttforge/alerts/hot/plant/boiler/temp", topic);

        var body = JsonDocument.Parse(payload).RootElement;

        // The same body as the webhook, which is the spec's own promise: one shape, two channels.
        Assert.Equal("raised", body.GetProperty("event").GetString());
        Assert.Equal("plant/boiler/temp", body.GetProperty("topic").GetString());
        Assert.Equal(94.2, body.GetProperty("value").GetDouble());
    }

    [Fact]
    public async Task The_console_hears_the_alert_over_the_hub()
    {
        await RingingAsync();

        var alert = await NextRaisedAsync();

        Assert.Equal("hot", alert.GetProperty("ruleId").GetString());
        Assert.Equal("Boiler temperature", alert.GetProperty("ruleName").GetString());
        Assert.Equal("plant/boiler/temp", alert.GetProperty("topic").GetString());
        Assert.Equal("critical", alert.GetProperty("severity").GetString());

        // The channels the rule asked for, so the panel can draw a notice for one of them and
        // play a tone for another without fetching the rule set to find out.
        var actions = alert.GetProperty("actions").EnumerateArray().Select(a => a.GetString()).ToList();
        Assert.Contains("screen", actions);
        Assert.Contains("webhook", actions);
        Assert.Contains("publish", actions);
    }

    // The other half of the body, and the half a receiver needs in order to close a ticket it
    // opened. An alarm that is only ever announced and never withdrawn is an inbox nobody trusts.
    [Fact]
    public async Task A_reading_back_under_the_line_sends_a_resolved_body()
    {
        await RingingAsync();

        await _probe!.NextAsync();
        await PublishAsync("plant/boiler/temp", "20.1");

        var body = JsonDocument.Parse((await _probe.NextAsync()).Body).RootElement;

        Assert.Equal("resolved", body.GetProperty("event").GetString());
        Assert.Equal("plant/boiler/temp", body.GetProperty("topic").GetString());
        Assert.True(DateTimeOffset.TryParse(body.GetProperty("resolvedAt").GetString(), out _),
            $"'resolvedAt' was not a moment: {body.GetProperty("resolvedAt")}");
        Assert.False(string.IsNullOrEmpty(body.GetProperty("resolvedBy").GetString()),
            "a resolved body has to say what let the alert go");
    }

    /// <summary>A started host, shipped in every way but the webhook switch.</summary>
    private WebApplicationFactory<Program> Started()
    {
        var factory = MqttForgeApiFactory.PointedAt(
            _settingsPath, _colourRulesPath, _savedProfilesPath, _alertRulesPath, _alertStatePath);

        var host = factory.WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
                config.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    // The factory turns webhooks off for the whole suite, and this delegate runs
                    // after it, so this source is the last one added and wins. The address the
                    // rule points at is a listener this class bound itself.
                    ["MqttForge:AllowWebhooks"] = "true"
                })));

        _hosts.Add(factory);
        _hosts.Add(host);

        // Asking for the services is what builds and starts the host, and starting it is what
        // starts the engine's loop and the supervisor that dials the broker off the settings file.
        _ = host.Services;

        return host;
    }

    /// <summary>A console, connected over the test server's own handler.</summary>
    private async Task ConsoleAsync(WebApplicationFactory<Program> host)
    {
        _console = new HubConnectionBuilder()
            .WithUrl(new Uri(host.Server.BaseAddress, "hubs/mqtt"),
                o => o.HttpMessageHandlerFactory = _ => host.Server.CreateHandler())
            .Build();

        // JsonElement rather than a record: the shape is the contract, and a record would bind
        // whatever it could and stay silent about the rest.
        _console.On<JsonElement[]>("alertsRaised", frame =>
        {
            foreach (var alert in frame) _raised.Writer.TryWrite(alert);
        });

        await _console.StartAsync();
    }

    /// <summary>Somebody else's client, watching the topics the engine publishes onto.</summary>
    private async Task ListenAsync(string filter)
    {
        _listener = new MqttClientFactory().CreateMqttClient();
        _listener.ApplicationMessageReceivedAsync += e =>
        {
            _published.Writer.TryWrite(
                (e.ApplicationMessage.Topic, e.ApplicationMessage.ConvertPayloadToString() ?? ""));

            return Task.CompletedTask;
        };

        await _listener.ConnectAsync(new MqttClientOptionsBuilder()
            .WithTcpServer(_broker.Host, _broker.Port)
            .WithClientId($"{_clientId}-ear")
            .WithCleanSession()
            .Build());

        await _listener.SubscribeAsync(new MqttClientSubscribeOptionsBuilder()
            .WithTopicFilter(filter, MqttQualityOfServiceLevel.AtLeastOnce)
            .Build());
    }

    /// <summary>The reading that starts it, from a client that is nothing to do with the app.</summary>
    // Kept connected across the run, unlike HeadlessAlertingTests's publisher, because the
    // resolve test publishes a second time after the first alarm has already been delivered.
    private async Task PublishAsync(string topic, string payload)
    {
        if (_publisher is null)
        {
            _publisher = new MqttClientFactory().CreateMqttClient();
            await _publisher.ConnectAsync(new MqttClientOptionsBuilder()
                .WithTcpServer(_broker.Host, _broker.Port)
                .WithClientId($"{_clientId}-pub")
                .Build());
        }

        await _publisher.PublishStringAsync(topic, payload);
    }

    private static async Task<T> ReadAsync<T>(Channel<T> channel)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));

        return await channel.Reader.ReadAsync(timeout.Token);
    }

    private async Task<JsonElement> NextRaisedAsync() => await ReadAsync(_raised);

    private async Task<(string Topic, string Payload)> NextPublishedAsync() => await ReadAsync(_published);

    /// <summary>Polls until something is true, or says what it was waiting for.</summary>
    private static async Task<T> Until<T>(Func<T> read, Func<T, bool> ready, string what)
    {
        var deadline = DateTime.UtcNow.AddSeconds(30);

        while (DateTime.UtcNow < deadline)
        {
            var value = read();
            if (ready(value)) return value;

            await Task.Delay(50);
        }

        throw new TimeoutException($"Timed out after 30 seconds waiting for {what}.");
    }

    public async Task DisposeAsync()
    {
        if (_console is not null) await _console.DisposeAsync();
        if (_listener is not null) await _listener.DisconnectAsync();
        if (_publisher is not null) await _publisher.DisconnectAsync();

        _listener?.Dispose();
        _publisher?.Dispose();

        // Awaited rather than disposed synchronously: this is what gives the host its shutdown,
        // and the webhook dispatcher's drain runs there.
        foreach (var host in _hosts) await host.DisposeAsync();

        if (_probe is not null) await _probe.DisposeAsync();

        foreach (var path in new[]
                 { _settingsPath, _colourRulesPath, _savedProfilesPath, _alertRulesPath, _alertStatePath })
            if (File.Exists(path)) File.Delete(path);
    }

    /// <summary>A real HTTP endpoint on a loopback port this class owns.</summary>
    // A substitute handler would prove that the dispatcher called something. This proves that
    // bytes left the process, over a socket, to an address written in a rules file — which is
    // the only version of the claim SECURITY.md is making on the operator's behalf.
    private sealed class WebhookProbe : IAsyncDisposable
    {
        public sealed record Delivery(string Body, string? Header, string ContentType);

        private readonly Channel<Delivery> _deliveries = Channel.CreateUnbounded<Delivery>();
        private readonly WebApplication _app;

        private WebhookProbe(WebApplication app) => _app = app;

        public static async Task<WebhookProbe> StartAsync()
        {
            var builder = WebApplication.CreateBuilder();

            // Port zero, so parallel runs of this suite never collide on a number, and loopback
            // only, so nothing outside this machine can reach it even for the seconds it is up.
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            builder.Logging.ClearProviders();

            var app = builder.Build();
            var probe = new WebhookProbe(app);

            app.MapPost("/hook", async (HttpRequest request) =>
            {
                using var reader = new StreamReader(request.Body, Encoding.UTF8);

                probe._deliveries.Writer.TryWrite(new Delivery(
                    await reader.ReadToEndAsync(),
                    request.Headers.TryGetValue("X-Forge-Plant", out var plant) ? plant.ToString() : null,
                    request.ContentType ?? ""));

                return Results.Ok();
            });

            await app.StartAsync();

            return probe;
        }

        /// <summary>The address a rule is given. Only known after the port has been assigned.</summary>
        public string Url => $"{_app.Urls.First()}/hook";

        public async Task<Delivery> NextAsync() => await ReadAsync(_deliveries);

        public async ValueTask DisposeAsync() => await _app.DisposeAsync();
    }
}
