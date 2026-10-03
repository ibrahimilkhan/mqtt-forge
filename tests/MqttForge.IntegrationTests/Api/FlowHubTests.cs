using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;
using MqttForge.Api.Contracts;
using MqttForge.Api.Hubs;
using MqttForge.Api.Realtime;
using MqttForge.Application.Flows;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using MqttForge.IntegrationTests.Support;
using NSubstitute;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

/// <summary>What a console is told about the flows, that the loop telling it can call a send off, and that a console hears it.</summary>
// Built as AlertHubTests is and for its reason: IHubContext lives in the ASP.NET shared framework,
// which only a project with a framework reference can compile against. Where a test reads what this
// notifier handed to SignalR the hub is a substitute; Tones_and_notices_reach_a_hub_client starts a
// host instead, and reads what reached a console connected to its hub.
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

    /// <summary>Start → Sound → Notify → End, with the name the notice greets in a variable.</summary>
    private static Flow Greeting()
    {
        static JsonElement Config(object config) => JsonSerializer.SerializeToElement(config, FlowJson.Options);

        return new Flow("greeting", "Control room greeting", true,
            [
                new FlowNode("start", "start", 0, 0, Config(new { })),
                new FlowNode("beep", "sound", 0, 0, Config(new { level = "critical" })),
                new FlowNode("tell", "notify", 0, 0, Config(new { text = "Hello {{var.who}}", level = "info" })),
                new FlowNode("end", "end", 0, 0, Config(new { })),
            ],
            [
                new FlowEdge("e1", "start", "out", "beep", "in"),
                new FlowEdge("e2", "beep", "out", "tell", "in"),
                new FlowEdge("e3", "tell", "out", "end", "in"),
            ])
        {
            Variables = [new FlowVariable("who", "world")],
        };
    }

    /// <summary>Starts a console on the host's hub, and comes back once a frame sent to every console has reached it.</summary>
    // StartAsync is over once the hub has answered the handshake, and the hub counts the console among the
    // ones a send to all goes to only after it has answered: a frame sent to all in that moment passes it
    // by. A tone and a notice are moments, never sent again, so no flow is switched on before a frame sent
    // to all has come.
    private static async Task ConnectedAsync(MqttForgeApiFactory host, HubConnection console)
    {
        var counted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        console.On("counted", () => counted.TrySetResult());
        await console.StartAsync();

        var hub = host.Services.GetRequiredService<IHubContext<MqttHub>>();
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(10);

        while (!counted.Task.IsCompleted)
        {
            Assert.True(DateTime.UtcNow < deadline, "No frame sent to every console reached this one.");
            await hub.Clients.All.SendAsync("counted");
            await Task.WhenAny(counted.Task, Task.Delay(50));
        }
    }

    // The whole trip, through a host and a console connected to its hub: a flow switched on, its Sound and
    // its Notify run, and the two frames the console's bridge listens for arrive in the words it reads.
    [Fact]
    public async Task Tones_and_notices_reach_a_hub_client()
    {
        using var host = new MqttForgeApiFactory();
        await using var console = new HubConnectionBuilder()
            .WithUrl(new Uri(host.Server.BaseAddress, "hubs/mqtt"),
                o => o.HttpMessageHandlerFactory = _ => host.Server.CreateHandler())
            .Build();

        // JsonElement rather than the DTOs: the shape is the contract, and a record would bind whatever
        // it could and stay silent about the rest.
        var tones = new ConcurrentQueue<JsonElement[]>();
        var notices = new ConcurrentQueue<JsonElement[]>();
        var toned = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var noticed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        console.On<JsonElement[]>("flowSound", frame =>
        {
            tones.Enqueue(frame);
            toned.TrySetResult();
        });
        console.On<JsonElement[]>("flowNotice", frame =>
        {
            notices.Enqueue(frame);
            noticed.TrySetResult();
        });

        await ConnectedAsync(host, console);

        Assert.Equal(HttpStatusCode.OK,
            (await host.CreateClient().PutAsJsonAsync("/api/flows/greeting", Greeting(), FlowJson.Options)).StatusCode);

        var both = Task.WhenAll(toned.Task, noticed.Task);
        if (await Task.WhenAny(both, Task.Delay(TimeSpan.FromSeconds(10))) != both)
            Assert.Fail($"In ten seconds the console heard {tones.Count} tone frames and {notices.Count} notice frames.");

        // One frame of each, with one tone and one notice in it: the flow ran once.
        var tone = Assert.Single(Assert.Single(tones));
        Assert.Equal("greeting", tone.GetProperty("flowId").GetString());
        Assert.Equal("beep", tone.GetProperty("nodeId").GetString());
        Assert.Equal("critical", tone.GetProperty("level").GetString());
        Assert.False(tone.GetProperty("test").GetBoolean());

        var notice = Assert.Single(Assert.Single(notices));
        Assert.Equal("greeting", notice.GetProperty("flowId").GetString());
        Assert.Equal("Control room greeting", notice.GetProperty("flowName").GetString());
        Assert.Equal("tell", notice.GetProperty("nodeId").GetString());
        Assert.Equal("Hello world", notice.GetProperty("text").GetString());
        Assert.Equal("info", notice.GetProperty("level").GetString());
        Assert.False(notice.GetProperty("test").GetBoolean());
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
