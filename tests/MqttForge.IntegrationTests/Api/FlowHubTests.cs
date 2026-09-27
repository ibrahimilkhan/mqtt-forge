using Microsoft.AspNetCore.SignalR;
using MqttForge.Api.Contracts;
using MqttForge.Api.Hubs;
using MqttForge.Api.Realtime;
using MqttForge.Application.Flows;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using NSubstitute;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

/// <summary>What a console is told about the flows, and that the loop telling it can call a send off.</summary>
// Built as AlertHubTests is and for its reason: IHubContext lives in the ASP.NET shared framework,
// which only a project with a framework reference can compile against. The hub is a substitute, so
// every assertion is about what this notifier handed to SignalR.
public class FlowHubTests
{
    private static readonly DateTimeOffset T0 = new(2026, 9, 26, 9, 0, 0, TimeSpan.Zero);

    private static Alert Fired(string? resolvedBy = null) =>
        new("a1", "flow-watch-hot", "Boiler watch · Hot", "plant/k1/temp", AlertSeverity.Critical,
            FiredAt: T0, LastSeenAt: T0,
            ResolvedAt: resolvedBy is null ? null : T0,
            ResolvedBy: resolvedBy,
            MutedUntil: null, Count: 1, Reason: "k1 at 95", Value: 95,
            Sample: "{\"temp\":95}", Actions: [new ScreenAction(), new SoundAction()]);

    private static SignalRFlowNotifier Notifier(RecordingHub hub) => new(hub.Context, new SignalRAlertNotifier(hub.Context));

    // The badge, the sound and the notice know an alarm by these two events alone, so a flow's alarm
    // needs nothing of its own on the console to be seen and heard.
    [Fact]
    public async Task A_flow_alarm_reaches_the_console_as_a_rules_does()
    {
        var hub = new RecordingHub();
        var notifier = Notifier(hub);

        await notifier.RaisedAsync([Fired()], CancellationToken.None);
        await notifier.ResolvedAsync([Fired(resolvedBy: "clear")], CancellationToken.None);

        Assert.Equal([SignalRAlertNotifier.AlertsRaised, SignalRAlertNotifier.AlertsResolved], hub.Methods);

        var raised = Assert.Single((AlertDto[])hub.Arguments[0][0]!);
        Assert.Equal("flow-watch-hot", raised.RuleId);
        Assert.Equal(["screen", "sound"], raised.Actions);
        Assert.Equal("clear", Assert.Single((AlertDto[])hub.Arguments[1][0]!).ResolvedBy);
    }

    // The flow engine sends from a loop it stops with itself, and a console that has stopped reading
    // holds a send until its connection times out: only the token the loop hands over can end it.
    [Fact]
    public async Task Every_send_carries_the_token_that_calls_it_off()
    {
        using var stop = new CancellationTokenSource();
        var hub = new RecordingHub();
        var notifier = Notifier(hub);

        await notifier.RaisedAsync([Fired()], stop.Token);
        await notifier.ResolvedAsync([Fired(resolvedBy: "clear")], stop.Token);
        await notifier.StatusAsync(FlowStatus.Empty, stop.Token);
        await notifier.DebugAsync([], 0, stop.Token);

        Assert.Equal(4, hub.Tokens.Count);
        Assert.All(hub.Tokens, token => Assert.Equal(stop.Token, token));
    }

    /// <summary>Captures what reached the hub: which method, with what, and with which token.</summary>
    private sealed class RecordingHub
    {
        private readonly List<(string Method, object?[] Arguments, CancellationToken Token)> _sends = [];

        public RecordingHub()
        {
            var proxy = Substitute.For<IClientProxy>();
            proxy
                .SendCoreAsync(Arg.Any<string>(), Arg.Any<object?[]>(), Arg.Any<CancellationToken>())
                .Returns(call =>
                {
                    _sends.Add((call.ArgAt<string>(0), call.Arg<object?[]>()!, call.ArgAt<CancellationToken>(2)));
                    return Task.CompletedTask;
                });

            var clients = Substitute.For<IHubClients>();
            clients.All.Returns(proxy);

            Context = Substitute.For<IHubContext<MqttHub>>();
            Context.Clients.Returns(clients);
        }

        public IHubContext<MqttHub> Context { get; }

        public IReadOnlyList<string> Methods => [.. _sends.Select(sent => sent.Method)];

        public IReadOnlyList<object?[]> Arguments => [.. _sends.Select(sent => sent.Arguments)];

        public IReadOnlyList<CancellationToken> Tokens => [.. _sends.Select(sent => sent.Token)];
    }
}
