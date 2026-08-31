using System.Threading.Channels;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using MqttForge.Application.Alerts;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Persistence;
using MqttForge.IntegrationTests.Support;
using MQTTnet;
using Xunit;

namespace MqttForge.IntegrationTests.Alerts;

/// <summary>
/// The sentence this whole part exists to make true: "a MQTTForge running headless in Docker
/// opens its own subscriptions, connects to the broker itself, and runs rules."
/// </summary>
// Nothing stands in for anything. There is a rules file on disk, a real Mosquitto in a container,
// a message published by somebody else's client, and an alert that arrives at IAlertNotifier —
// and in the whole file there is no HttpClient, no SignalR connection and no browser. The only
// substitution is the notifier itself, which is how a test hears what a console would have heard.
//
// The container is MosquittoFixture, taken as a class fixture exactly as MqttnetSubscribeTests
// and SubscriptionEndpointTests take it, and like them this class does not skip when Docker is
// absent. LiveBrokerFact — the one attribute here that skips — is for brokers out on the
// internet, and a broker this suite starts itself is not one of those.
public class HeadlessAlertingTests : IClassFixture<MosquittoFixture>, IDisposable
{
    private readonly MosquittoFixture _broker;
    private readonly RecordingAlertNotifier _alerts = new();
    private readonly List<WebApplicationFactory<Program>> _hosts = [];

    private readonly string _settingsPath = Temp("headless-settings");
    private readonly string _colourRulesPath = Temp("headless-colours");
    private readonly string _savedProfilesPath = Temp("headless-brokers");
    private readonly string _alertRulesPath = Temp("headless-rules");
    private readonly string _alertStatePath = Temp("headless-state");

    // One id for both runs of the restart tests, because it is meant to be the same installation
    // coming back. They never overlap: the first is closed before the second is started.
    private readonly string _clientId = $"headless-{Guid.NewGuid():N}"[..23];

    public HeadlessAlertingTests(MosquittoFixture broker) => _broker = broker;

    /// The single rule the file holds. Screen only — a webhook would need an endpoint, and the
    /// factory turns webhooks off for every test that does not deliberately want one.
    private static readonly AlertRule Hot = new(
        "hot", "Boiler temperature", Enabled: true, "plant/+/temp", Field: null,
        new ThresholdCondition(ThresholdOp.Gt, 90), Clear: null, For: null, Cooldown: null,
        AlertSeverity.Warn, [new ScreenAction()]);

    private static string Temp(string what) =>
        Path.Combine(Path.GetTempPath(), $"mqttforge-{what}-{Guid.NewGuid():N}.json");

    /// <summary>Writes exactly what a MQTTForge that had been used once would leave behind: the
    /// broker it last connected to, and the rules somebody saved.</summary>
    // Through the real stores rather than by hand. A JSON literal here would pass while the store
    // wrote something else, and the shape of these two files is the contract this run depends on.
    private async Task GivenTheFilesAsync()
    {
        await new JsonConnectionSettingsStore(_settingsPath).SaveAsync(
            new BrokerConnectionSettings(_broker.Host, _broker.Port, _clientId, null, null, false),
            CancellationToken.None);

        await new JsonAlertRuleStore(_alertRulesPath).SaveAsync([Hot], CancellationToken.None);
    }

    /// <summary>A started host, with the recorder standing in for the alert notifier.</summary>
    private WebApplicationFactory<Program> Started()
    {
        var factory = MqttForgeApiFactory.PointedAt(
            _settingsPath, _colourRulesPath, _savedProfilesPath, _alertRulesPath, _alertStatePath);

        var host = factory.WithWebHostBuilder(builder =>
            builder.ConfigureTestServices(services => services.AddSingleton<IAlertNotifier>(_alerts)));

        _hosts.Add(factory);
        _hosts.Add(host);

        // Asking for the services is what builds and starts the host, and starting it is what
        // starts the hosted services — the engine's loop, and the supervisor that dials the
        // broker off the settings file. No client is ever created: this run has no console.
        _ = host.Services;

        return host;
    }

    /// <summary>Files, host, the engine's own subscription, and one reading over the line.</summary>
    private async Task<(WebApplicationFactory<Program> Host, Alert Ringing)> RingingAsync()
    {
        await GivenTheFilesAsync();

        var host = Started();
        var subscriber = host.Services.GetRequiredService<IMqttSubscriber>();

        // The wait that cannot be skipped. MQTT keeps nothing for a subscriber that was not there
        // yet, so a message published before the SUBSCRIBE lands is simply gone, and this test
        // would fail for a reason that has nothing to do with alerting.
        await Until(() => subscriber.Filters, filters => filters.Any(f => f.Filter == Hot.Filter),
            "the engine to subscribe the rule's filter");

        await PublishAsync("plant/boiler/temp", "94.2");

        return (host, await _alerts.NextRaised());
    }

    [Fact]
    public async Task A_rule_on_disk_fires_from_a_message_nobody_in_a_browser_asked_for()
    {
        var (_, ringing) = await RingingAsync();

        Assert.Equal("hot", ringing.RuleId);
        Assert.Equal("Boiler temperature", ringing.RuleName);
        Assert.Equal("plant/boiler/temp", ringing.Topic);
        Assert.Equal(94.2, ringing.Value);
        Assert.Equal(AlertSeverity.Warn, ringing.Severity);
        Assert.Null(ringing.ResolvedAt);
    }

    // "Subscribed" has to mean at the broker, not in a dictionary somewhere. That half is already
    // proved above and cannot be faked: nothing here ever called POST /api/subscriptions, and a
    // broker holding no subscription forwards nothing, so the alert could only come from a
    // SUBSCRIBE that really went out. What is asserted here is the other half — that the engine
    // took the filter in its own name, so a console unsubscribing later cannot take a rule's ears
    // away with it.
    [Fact]
    public async Task The_rules_filter_is_the_engines_own_subscription()
    {
        var (host, _) = await RingingAsync();

        var filter = Assert.Single(host.Services.GetRequiredService<IMqttSubscriber>().Filters);

        Assert.Equal(Hot.Filter, filter.Filter);
        Assert.Equal(SubscriptionOwner.Rules, filter.Owners);
    }

    // A restart is the ordinary event in the deployment this feature is for: a container is
    // replaced, and an alarm that was ringing has to still be ringing afterwards. Coming back
    // with an empty panel would tell the operator the plant recovered.
    [Fact]
    public async Task A_restart_picks_up_the_alarm_that_was_still_ringing()
    {
        var (first, ringing) = await RingingAsync();
        await first.DisposeAsync();

        Assert.True(File.Exists(_alertStatePath), $"{_alertStatePath} was never written");

        var engine = Started().Services.GetRequiredService<AlertEngine>();

        var active = await Until(() => engine.Snapshot.Active, alerts => alerts.Count > 0,
            "the restarted engine to bring the alarm back");

        var restored = Assert.Single(active);

        Assert.Equal(ringing.Id, restored.Id);
        Assert.Equal(ringing.Topic, restored.Topic);

        // The moment it first fired, not the moment it was read back. A fresh alarm would be
        // stamped with the restart, and nothing published between the two runs anyway — so this
        // is the assertion that says 'restored' rather than 'fired again'.
        Assert.Equal(ringing.FiredAt, restored.FiredAt);
    }

    [Fact]
    public async Task A_reading_back_under_the_line_resolves_the_alarm_the_restart_restored()
    {
        var (first, _) = await RingingAsync();
        await first.DisposeAsync();

        var second = Started();
        var engine = second.Services.GetRequiredService<AlertEngine>();
        var subscriber = second.Services.GetRequiredService<IMqttSubscriber>();

        await Until(() => engine.Snapshot.Active, alerts => alerts.Count > 0,
            "the restarted engine to bring the alarm back");
        await Until(() => subscriber.Filters, filters => filters.Any(f => f.Filter == Hot.Filter),
            "the restarted engine to subscribe the rule's filter again");

        await PublishAsync("plant/boiler/temp", "20.1");

        var resolved = await _alerts.NextResolved();

        Assert.Equal("plant/boiler/temp", resolved.Topic);
        Assert.NotNull(resolved.ResolvedAt);

        // And it left the panel as well as the notifier. Resolving on the wire while the snapshot
        // still holds the alert is the failure a console would show as an alarm that never ends.
        await Until(() => engine.Snapshot.Active, alerts => alerts.Count == 0,
            "the panel to empty");
    }

    /// <summary>Polls until something is true, or says what it was waiting for.</summary>
    // The same shape MqttnetSubscribeTests uses for the disconnect it cannot await: these are
    // background loops with a one-second tick, so there is nothing to await and a fixed sleep
    // would be either flaky or slow.
    private static async Task<T> Until<T>(Func<T> read, Func<T, bool> ready, string what)
    {
        var deadline = DateTime.UtcNow.AddSeconds(20);

        while (DateTime.UtcNow < deadline)
        {
            var value = read();
            if (ready(value)) return value;

            await Task.Delay(50);
        }

        throw new TimeoutException($"Timed out after 20 seconds waiting for {what}.");
    }

    /// <summary>Somebody else's client, on the same broker.</summary>
    // Disconnecting immediately after the publish is safe: it is the same TCP stream, so the
    // broker reads the PUBLISH before the DISCONNECT. And every caller asserts on what the
    // message caused, so a publish that never landed fails as a timeout naming what it waited for.
    private async Task PublishAsync(string topic, string payload)
    {
        using var publisher = new MqttClientFactory().CreateMqttClient();

        await publisher.ConnectAsync(new MqttClientOptionsBuilder()
            .WithTcpServer(_broker.Host, _broker.Port).Build());
        await publisher.PublishStringAsync(topic, payload);
        await publisher.DisconnectAsync();
    }

    public void Dispose()
    {
        foreach (var host in _hosts) host.Dispose();

        foreach (var path in new[]
                 { _settingsPath, _colourRulesPath, _savedProfilesPath, _alertRulesPath, _alertStatePath })
            if (File.Exists(path)) File.Delete(path);
    }

    /// <summary>Stands where the console's notifier will stand in part 3, and keeps what it hears.</summary>
    // Channels rather than a TaskCompletionSource: a run raises one alert and resolves it later,
    // and a completion source can only carry the first of anything. Unbounded, because the whole
    // point is that nothing here is allowed to slow the engine down.
    private sealed class RecordingAlertNotifier : IAlertNotifier
    {
        private readonly Channel<Alert> _raised = Channel.CreateUnbounded<Alert>();
        private readonly Channel<Alert> _resolved = Channel.CreateUnbounded<Alert>();

        public Task RaisedAsync(IReadOnlyList<Alert> alerts)
        {
            foreach (var alert in alerts) _raised.Writer.TryWrite(alert);

            return Task.CompletedTask;
        }

        public Task ResolvedAsync(IReadOnlyList<Alert> alerts)
        {
            foreach (var alert in alerts) _resolved.Writer.TryWrite(alert);

            return Task.CompletedTask;
        }

        // Counted by the engine and reported to the console; nothing in this file drops anything.
        public Task DroppedAsync(int total) => Task.CompletedTask;

        public async Task<Alert> NextRaised() => await Next(_raised);

        public async Task<Alert> NextResolved() => await Next(_resolved);

        private static async Task<Alert> Next(Channel<Alert> channel)
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));

            return await channel.Reader.ReadAsync(timeout.Token);
        }
    }
}
