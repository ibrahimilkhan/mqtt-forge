using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using MqttForge.Api;
using MqttForge.Application.Flows;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Persistence;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

// The questions only a built container can answer: that the pieces resolve, that the broker's
// messages reach the flow engine the rest of the app holds, and that the engine is hosted between
// the alert engine and the supervisor.
public class FlowWiringTests
{
    private static WebApplication Host() =>
        MqttForgeHost.Build([
            $"--MqttForge:SettingsPath={Temp("flow-wiring-settings")}",
            $"--MqttForge:AlertRulesPath={Temp("flow-wiring-rules")}",
            $"--MqttForge:AlertStatePath={Temp("flow-wiring-state")}",
            $"--MqttForge:FlowsPath={Temp("flow-wiring-flows")}",
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
}
