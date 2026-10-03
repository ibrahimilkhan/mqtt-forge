using System.Reflection;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using MqttForge.Api;
using MqttForge.Api.Realtime;
using MqttForge.Application.Flows;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Alerts;
using MqttForge.Infrastructure.Persistence;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

// The questions only a built container can answer: that the pieces resolve, that the broker's
// messages reach the flow engine the rest of the app holds, and that the engine is hosted between
// the alert engine and the supervisor.
public class FlowWiringTests
{
    private static WebApplication Host(params string[] extra) =>
        MqttForgeHost.Build([
            $"--MqttForge:SettingsPath={Temp("flow-wiring-settings")}",
            $"--MqttForge:AlertRulesPath={Temp("flow-wiring-rules")}",
            $"--MqttForge:AlertStatePath={Temp("flow-wiring-state")}",
            $"--MqttForge:FlowsPath={Temp("flow-wiring-flows")}",
            .. extra
        ]);

    private static string Temp(string what) =>
        Path.Combine(Path.GetTempPath(), $"mqttforge-{what}-{Guid.NewGuid():N}.json");

    [Fact]
    public async Task Every_piece_of_the_flow_engine_resolves()
    {
        await using var app = Host();

        Assert.IsType<JsonFlowStore>(app.Services.GetRequiredService<IFlowStore>());
        Assert.NotNull(app.Services.GetRequiredService<FlowRuntime>());
        Assert.NotNull(app.Services.GetRequiredService<FlowEngine>());
        Assert.NotNull(app.Services.GetRequiredService<IFlowNotifier>());
    }

    [Fact]
    public async Task An_arrival_through_the_fan_out_reaches_the_flow_engine_the_app_holds()
    {
        await using var app = Host();

        var notifier = app.Services.GetRequiredService<IMessageNotifier>();
        var engine = app.Services.GetRequiredService<FlowEngine>();

        for (var i = 0; i <= FlowEngine.QueueCapacity; i++)
            await notifier.NotifyMessageReceivedAsync(
                new MqttMessage($"plant/{i}/temp", "1", "text", 0, false, DateTimeOffset.UnixEpoch));

        Assert.Equal(1, engine.Dropped);
    }

    [Fact]
    public async Task The_flow_engine_is_hosted_after_the_alert_engine_and_before_the_supervisor()
    {
        await using var app = Host();

        var hosted = app.Services.GetServices<IHostedService>().ToList();
        var flows = hosted.FindIndex(service => service is FlowEngineHost);

        Assert.True(flows > hosted.FindIndex(service => service is AlertEngineHost));
        Assert.True(flows < hosted.FindIndex(service => service is BrokerLinkSupervisor));
    }

    // One channel decides what leaves this machine for an address somebody typed, and a flow's post is one
    // more thing that leaves. So it goes through that channel — the instance the container hosts and the
    // alert dispatcher holds, with its queue, its client that does not follow a redirect, its retries and
    // its budget — and a host that turned webhooks off hands the engine no channel at all. The dispatcher
    // refuses a post of its own accord as well, which is why this cannot be seen from what a Webhook node
    // says: the same sentence comes back either way, and only the engine's field tells the doors apart.
    [Fact]
    public async Task The_flow_engine_posts_webhooks_through_the_alert_webhook_channel_only_when_webhooks_are_allowed()
    {
        await using var on = Host("--MqttForge:AllowWebhooks=true");
        await using var off = Host("--MqttForge:AllowWebhooks=false");

        // The same object three ways. A second dispatcher built for the engine would queue its posts for a
        // pump nobody started, and take them nowhere without a word.
        var dispatcher = on.Services.GetRequiredService<WebhookDispatcher>();
        var alerts = Assert.IsType<CompositeAlertDispatcher>(on.Services.GetRequiredService<IAlertDispatcher>());

        Assert.Same(dispatcher, WebhookOf(on.Services.GetRequiredService<FlowEngine>()));
        Assert.Same(dispatcher, Assert.Single(alerts.Targets.OfType<WebhookDispatcher>()));
        Assert.Same(dispatcher, Assert.Single(on.Services.GetServices<IHostedService>().OfType<WebhookDispatcher>()));

        // Nothing for a post to go to, though the dispatcher is still built and hosted in this host: the
        // switch is about what leaves, not about what is registered.
        Assert.NotNull(off.Services.GetRequiredService<WebhookDispatcher>());
        Assert.Null(WebhookOf(off.Services.GetRequiredService<FlowEngine>()));
    }

    // The engine keeps its webhook channel in a private field and shows nobody which one it was given,
    // and which one is exactly what the wiring decides. By name, so a rename is said as one here and not
    // as a NullReferenceException that sends the reader looking at the container.
    private static IFlowWebhook? WebhookOf(FlowEngine engine)
    {
        var field = typeof(FlowEngine).GetField("_webhook", BindingFlags.Instance | BindingFlags.NonPublic)
                    ?? throw new InvalidOperationException(
                        "FlowEngine has no field called _webhook any more, which holds the channel its Webhook " +
                        "nodes' posts go to. Point this test at wherever the engine keeps it now.");

        return (IFlowWebhook?)field.GetValue(engine);
    }
}
