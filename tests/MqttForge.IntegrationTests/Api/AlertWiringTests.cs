using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using MqttForge.Api;
using MqttForge.Api.Realtime;
using MqttForge.Application.Alerts;
using MqttForge.Application.Services;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Persistence;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

/// <summary>
/// What the container actually hands out once the alerting engine is in it.
/// </summary>
// Beside AlertContainerTests rather than inside it, because the two ask different questions and
// only one of them can fail politely. That file exists for the notifier ring, whose failure is a
// StackOverflowException that takes the whole runner down; this one is ordinary assertions about
// ordinary registrations, and it is long enough to deserve its own name.
public class AlertWiringTests
{
    // Every path is pointed at a fresh temporary file. A host that shared the shipped location
    // would read whatever the developer's own machine happens to be holding, and a test that
    // passes because of what is on one disk is not a test.
    private static WebApplication Host(params string[] extra) =>
        MqttForgeHost.Build([
            $"--MqttForge:SettingsPath={Temp("wiring-settings")}",
            $"--MqttForge:AlertRulesPath={Temp("wiring-rules")}",
            $"--MqttForge:AlertStatePath={Temp("wiring-state")}",
            .. extra
        ]);

    private static string Temp(string what) =>
        Path.Combine(Path.GetTempPath(), $"mqttforge-{what}-{Guid.NewGuid():N}.json");

    /// <summary>The options the container built, not a fresh record with the shipped defaults.</summary>
    // The whole point of the configuration tests below: asking the container what it made is the
    // only way to catch a registration that silently ignored the setting it was given.
    private static AlertEngineOptions OptionsOf(WebApplication app) =>
        app.Services.GetRequiredService<AlertEngineOptions>();

    [Fact]
    public async Task Every_piece_of_the_alerting_engine_resolves()
    {
        await using var app = Host();

        // The three faces that could each be satisfied by the wrong object, named.
        Assert.IsType<JsonAlertRuleStore>(app.Services.GetRequiredService<IAlertRuleStore>());
        Assert.IsType<JsonAlertStateStore>(app.Services.GetRequiredService<IAlertStateStore>());
        // The composite, not the logger. Part 2 registered the logger directly, because there was
        // no console channel yet; part 3 puts the hub beside it and the logger inside it, so a
        // headless container goes on saying what it decided while a console gets the events.
        Assert.IsType<CompositeAlertNotifier>(app.Services.GetRequiredService<IAlertNotifier>());

        // And the four that only have to exist. GetRequiredService throws when they do not, so
        // the assertion is the call; NotNull is here to say the call was the point.
        Assert.NotNull(app.Services.GetRequiredService<AlertEngineOptions>());
        Assert.NotNull(app.Services.GetRequiredService<AlertEngineCore>());
        Assert.NotNull(app.Services.GetRequiredService<AlertEngine>());
        Assert.NotNull(app.Services.GetRequiredService<AlertRuleService>());
    }

    [Fact]
    public async Task The_notifier_everything_upstream_sees_is_the_fan_out()
    {
        await using var app = Host();

        var notifier = app.Services.GetRequiredService<IMessageNotifier>();

        Assert.IsType<FanOutMessageNotifier>(notifier);

        // One instance under two faces, the way SignalRMessageNotifier already is. Two fan-outs
        // would both work and only one of them would be the one the subscriber is holding.
        Assert.Same(app.Services.GetRequiredService<FanOutMessageNotifier>(), notifier);
    }

    // The console's pump did not move, and the order of the other two matters: hosted services
    // start in registration order, so the engine's loop is already pumping before the supervisor
    // dials the broker. The other way round, the first seconds of traffic after a reconnect land
    // in a queue nobody is draining yet.
    [Fact]
    public async Task The_pump_the_engine_and_the_supervisor_are_all_hosted_in_that_order()
    {
        await using var app = Host();

        var hosted = app.Services.GetServices<IHostedService>().ToList();

        Assert.Same(
            app.Services.GetRequiredService<SignalRMessageNotifier>(),
            hosted.OfType<SignalRMessageNotifier>().Single());
        Assert.Single(hosted.OfType<AlertEngineHost>());
        Assert.Single(hosted.OfType<BrokerLinkSupervisor>());

        Assert.True(
            hosted.FindIndex(service => service is AlertEngineHost)
            < hosted.FindIndex(service => service is BrokerLinkSupervisor),
            "the broker link must come up after the loop that is going to read from it");
    }

    // The identity that actually matters, and the only one a type assertion cannot make: what the
    // broker hands to the fan-out has to land in the engine the rest of the app holds. A second
    // AlertEngine would be invisible until somebody asked why the panel never fills.
    [Fact]
    public async Task An_arrival_through_the_fan_out_reaches_the_engine_the_rest_of_the_app_holds()
    {
        await using var app = Host();

        var notifier = app.Services.GetRequiredService<IMessageNotifier>();
        var engine = app.Services.GetRequiredService<AlertEngine>();

        // Nothing is pumping — no host was started — so the queue fills and the message past its
        // capacity is dropped. That count is read off the engine this test resolved, and it can
        // only be one if the fan-out was given the same object.
        for (var i = 0; i <= AlertEngine.QueueCapacity; i++)
            await notifier.NotifyMessageReceivedAsync(
                new MqttMessage($"plant/{i}/temp", "1", "text", 0, false, DateTimeOffset.UnixEpoch));

        Assert.Equal(1, engine.Dropped);
    }

    [Fact]
    public async Task The_alert_topic_prefix_comes_from_configuration()
    {
        await using var app = Host("--MqttForge:AlertTopicPrefix=site/alarms/");

        Assert.Equal("site/alarms/", OptionsOf(app).TopicPrefix);
    }

    [Fact]
    public async Task The_shipped_prefix_stands_when_nothing_names_one()
    {
        await using var app = Host();

        Assert.Equal("mqttforge/alerts/", OptionsOf(app).TopicPrefix);
    }

    // A prefix is a prefix of a topic, not a word in front of one. Without the slash,
    // 'site/alarms' + 'hot/plant/boiler/temp' is 'site/alarmshot/…', which the loop guard cannot
    // see and the publish action writes to a topic tree nobody meant to create.
    [Fact]
    public async Task A_prefix_written_without_its_trailing_slash_gets_one()
    {
        await using var app = Host("--MqttForge:AlertTopicPrefix=site/alarms");

        Assert.Equal("site/alarms/", OptionsOf(app).TopicPrefix);
    }

    // An empty prefix is not 'no prefix', it is 'every topic on the broker is mine': the loop
    // guard would refuse to evaluate anything at all. The shipped value stands instead.
    [Fact]
    public async Task A_prefix_that_is_nothing_but_space_leaves_the_shipped_one_standing()
    {
        await using var app = Host("--MqttForge:AlertTopicPrefix=   ");

        Assert.Equal("mqttforge/alerts/", OptionsOf(app).TopicPrefix);
    }

    [Fact]
    public async Task Webhooks_ship_on_and_configuration_can_turn_them_off()
    {
        await using var on = Host();
        Assert.True(OptionsOf(on).AllowWebhooks);

        await using var off = Host("--MqttForge:AllowWebhooks=false");
        Assert.False(OptionsOf(off).AllowWebhooks);
    }

    // 'no' is not a bool, and reading it as one would be inventing a syntax. Of the two ways to
    // be wrong about a value nobody can read, leaving the switch where it ships is the better
    // one: the endpoint a webhook posts to is the operator's own, written in their own rules
    // file, while the other mistake is an alerting channel going quiet — which is the exact
    // failure this whole feature exists to prevent.
    [Fact]
    public async Task A_switch_nobody_can_read_leaves_webhooks_where_they_ship()
    {
        await using var app = Host("--MqttForge:AllowWebhooks=no");

        Assert.True(OptionsOf(app).AllowWebhooks);
    }

    // The spec's 'Sayılar' table costs the close at ten seconds, four of them the drain. Ten is
    // also what Docker gives between SIGTERM and SIGKILL, so a host that reserved the framework's
    // thirty would simply be killed halfway through writing alert-state.json down.
    [Fact]
    public async Task The_shutdown_budget_is_the_ten_seconds_the_close_was_costed_at()
    {
        await using var app = Host();

        var options = app.Services.GetRequiredService<IOptions<HostOptions>>().Value;

        Assert.Equal(TimeSpan.FromSeconds(10), options.ShutdownTimeout);
    }
}
