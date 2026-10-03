using System.Text.Json;
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

    // A flow alarm's actions are the screen alone: a tone or a notice is a step the flow draws after it.
    private static Alert Fired(string? resolvedBy = null) =>
        new("a1", "flow-watch-hot", "Boiler watch · Hot", "plant/k1/temp", AlertSeverity.Critical,
            FiredAt: T0, LastSeenAt: T0,
            ResolvedAt: resolvedBy is null ? null : T0,
            ResolvedBy: resolvedBy,
            MutedUntil: null, Count: 1, Reason: "k1 at 95", Value: 95,
            Sample: "{\"temp\":95}", Actions: [new ScreenAction()]);

    private static SignalRFlowNotifier Notifier(RecordingHub hub) => new(hub.Context, new SignalRAlertNotifier(hub.Context));

    /// <summary>A frame's argument as the hub writes it: camelCase names, enums as words.</summary>
    private static JsonElement Written(object? argument) =>
        JsonSerializer.SerializeToElement(argument, WireJson.Client);

    // The badge and the alarm list know an alarm by these two events alone, so a flow's alarm needs
    // nothing of its own on the console to be seen.
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
        Assert.Equal(["screen"], raised.Actions);
        Assert.Equal("clear", Assert.Single((AlertDto[])hub.Arguments[1][0]!).ResolvedBy);
    }

    // What the console's hub bridge reads, word for word: the runs, a line that says whether a test
    // printed it, and a tone and a notice under events of their own.
    [Fact]
    public async Task Runs_lines_tones_and_notices_go_out_under_their_own_events_in_the_words_the_console_reads()
    {
        var hub = new RecordingHub();
        var notifier = Notifier(hub);

        await notifier.StatusAsync(new FlowStatus([new FlowRunStatus("watch", FlowRunKind.Test, FlowRunState.Waiting, "in",
            new FlowWaiting(null, "plant/+/temp"), null, new Dictionary<string, string> { ["Limit_A"] = "90" }, [])]), CancellationToken.None);
        await notifier.DebugAsync([new FlowDebugEntry("watch", "say", T0, FlowDebugEntry.Message, "a/b", "hello", Test: true)], 0, CancellationToken.None);
        await notifier.SoundsAsync([new FlowSound("watch", "beep", AlertSeverity.Warn, Test: false)], CancellationToken.None);
        await notifier.NoticesAsync([new FlowNotice("watch", "Boiler watch", "tell", "k1 is hot", AlertSeverity.Critical, T0, Test: true)],
            CancellationToken.None);

        Assert.Equal(["flowStatus", "flowDebug", "flowSound", "flowNotice"], hub.Methods);

        var run = Assert.Single(Written(hub.Arguments[0][0]).GetProperty("runs").EnumerateArray());
        Assert.Equal("watch", run.GetProperty("flowId").GetString());
        Assert.Equal("test", run.GetProperty("kind").GetString());
        Assert.Equal("waiting", run.GetProperty("state").GetString());
        Assert.Equal("in", run.GetProperty("at").GetString());
        Assert.Equal("plant/+/temp", run.GetProperty("waiting").GetProperty("filter").GetString());
        Assert.Equal(JsonValueKind.Null, run.GetProperty("waiting").GetProperty("until").ValueKind);
        Assert.Equal("90", run.GetProperty("variables").GetProperty("Limit_A").GetString());

        Assert.True(Assert.Single(Written(hub.Arguments[1][0]).EnumerateArray()).GetProperty("test").GetBoolean());

        var tone = Assert.Single(Written(hub.Arguments[2][0]).EnumerateArray());
        Assert.Equal("beep", tone.GetProperty("nodeId").GetString());
        Assert.Equal("warn", tone.GetProperty("level").GetString());
        Assert.False(tone.GetProperty("test").GetBoolean());

        var notice = Assert.Single(Written(hub.Arguments[3][0]).EnumerateArray());
        Assert.Equal("Boiler watch", notice.GetProperty("flowName").GetString());
        Assert.Equal("k1 is hot", notice.GetProperty("text").GetString());
        Assert.Equal("critical", notice.GetProperty("level").GetString());
        Assert.True(notice.GetProperty("test").GetBoolean());
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
        await notifier.SoundsAsync([], stop.Token);
        await notifier.NoticesAsync([], stop.Token);

        Assert.Equal(6, hub.Tokens.Count);
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
