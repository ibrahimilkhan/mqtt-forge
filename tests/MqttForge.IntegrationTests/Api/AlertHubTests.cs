using Microsoft.AspNetCore.SignalR;
using MqttForge.Api.Contracts;
using MqttForge.Api.Hubs;
using MqttForge.Api.Realtime;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using NSubstitute;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

/// <summary>
/// What a console is actually told when an alarm starts, stops, is muted, or is missed.
/// </summary>
// Beside MessageBatchingTests and built the same way, for the same reason it is in this project
// rather than the unit one: IHubContext lives in the ASP.NET shared framework, which only a
// project with a framework reference can compile against.
//
// Nothing here starts a host. The hub is a substitute, so every assertion is about the object
// this notifier handed to SignalR — which is the only part of the trip this class owns.
public class AlertHubTests
{
    private static readonly DateTimeOffset T0 = new(2026, 8, 30, 9, 0, 0, TimeSpan.Zero);

    private static Alert Fired(
        string id = "a1",
        string topic = "plant/boiler/temp",
        AlertSeverity severity = AlertSeverity.Critical,
        string? resolvedBy = null,
        string? sample = "{\"temp\":94.2}") =>
        new(id, "hot", "Boiler temperature", topic, severity,
            FiredAt: T0, LastSeenAt: T0,
            ResolvedAt: resolvedBy is null ? null : T0,
            ResolvedBy: resolvedBy,
            MutedUntil: null, Count: 1, Reason: "94.2 > 90", Value: 94.2,
            Sample: sample, Actions: [new ScreenAction(), new SoundAction()]);

    [Fact]
    public async Task Raised_alerts_reach_the_console_as_the_dto_the_panel_reads()
    {
        var hub = new RecordingAlertHub();

        await new SignalRAlertNotifier(hub.Context).RaisedAsync([Fired()]);

        var alert = Assert.Single(hub.Frame(SignalRAlertNotifier.AlertsRaised));

        Assert.Equal("a1", alert.Id);
        Assert.Equal("hot", alert.RuleId);
        Assert.Equal("Boiler temperature", alert.RuleName);
        Assert.Equal("plant/boiler/temp", alert.Topic);
        Assert.Equal(AlertSeverity.Critical, alert.Severity);
        Assert.Equal(T0, alert.FiredAt);
        Assert.Equal("94.2 > 90", alert.Reason);
        Assert.Equal(94.2, alert.Value);
        Assert.Null(alert.ResolvedAt);

        // The channels a rule asked for, by name. The console draws a notice for one and plays a
        // tone for the other, and it can only tell them apart if the names travel.
        Assert.Equal(["screen", "sound"], alert.Actions);
    }

    // Its own method rather than a flag on the batch. Every channel downstream treats the two
    // halves differently, and a console unpacking a record to find out which half it was given
    // is the shape IAlertNotifier was split in two to avoid.
    [Fact]
    public async Task Resolved_alerts_travel_under_their_own_name()
    {
        var hub = new RecordingAlertHub();

        await new SignalRAlertNotifier(hub.Context).ResolvedAsync([Fired(resolvedBy: "clear")]);

        var alert = Assert.Single(hub.Frame(SignalRAlertNotifier.AlertsResolved));

        Assert.Equal("clear", alert.ResolvedBy);
        Assert.Equal(T0, alert.ResolvedAt);
        Assert.Empty(hub.Frames(SignalRAlertNotifier.AlertsRaised));
    }

    // The engine calls this on every turn that changed anything, and most turns change nothing on
    // one of the two lists. An empty frame a second is a websocket kept awake for no reason.
    [Fact]
    public async Task A_tick_with_nothing_to_say_sends_nothing()
    {
        var hub = new RecordingAlertHub();
        var notifier = new SignalRAlertNotifier(hub.Context);

        await notifier.RaisedAsync([]);
        await notifier.ResolvedAsync([]);

        Assert.True(hub.SaidNothing);
    }

    // The pair, not an id. Muting addresses a (rule, topic) pair because that is what an alarm
    // belongs to, and 'until' is sent so the panel can count down without asking again.
    [Fact]
    public async Task A_mute_names_the_pair_and_the_moment_it_lifts()
    {
        var hub = new RecordingAlertHub();
        DateTimeOffset? until = T0.AddMinutes(30);

        await new SignalRAlertNotifier(hub.Context)
            .MutedAsync("hot", "plant/boiler/temp", until);

        Assert.Equal(
            ["hot", "plant/boiler/temp", until],
            hub.Arguments(SignalRAlertNotifier.AlertMuted));
    }

    // Zero minutes is the panel's "Geri al", and it is a mute event like any other: the row has to
    // stop being faded on every console, not only on the one whose button was pressed. A signature
    // that could not say 'no longer muted' would have left this case to the next poll of
    // GET /api/alerts, which is the latency this event exists to remove.
    [Fact]
    public async Task A_lift_travels_as_null_rather_than_as_a_moment()
    {
        var hub = new RecordingAlertHub();

        await new SignalRAlertNotifier(hub.Context)
            .MutedAsync("hot", "plant/boiler/temp", until: null);

        var arguments = hub.Arguments(SignalRAlertNotifier.AlertMuted);

        Assert.Equal("hot", arguments[0]);
        Assert.Equal("plant/boiler/temp", arguments[1]);
        Assert.Null(arguments[2]);
    }

    [Fact]
    public async Task The_drop_total_is_sent_when_it_moves()
    {
        var hub = new RecordingAlertHub();

        await new SignalRAlertNotifier(hub.Context).DroppedAsync(12);

        Assert.Equal(12, Assert.Single(hub.Arguments(SignalRAlertNotifier.AlertsDropped)));
    }

    // The engine already guards this, and so does this class: DroppedAsync carries a running
    // total, and a total that has not moved is not news. Guarded in both places on purpose —
    // the composite means this method has more than one possible caller.
    [Fact]
    public async Task The_same_drop_total_is_not_sent_twice()
    {
        var hub = new RecordingAlertHub();
        var notifier = new SignalRAlertNotifier(hub.Context);

        await notifier.DroppedAsync(12);
        await notifier.DroppedAsync(12);
        await notifier.DroppedAsync(13);

        Assert.Equal([12, 13], hub.Arguments(SignalRAlertNotifier.AlertsDropped));
    }

    // A restart that brings back every alarm that was ringing hands this one list, and one frame
    // carrying all of them is a message the browser has to parse whole before it can draw a row.
    [Fact]
    public async Task A_restore_bigger_than_one_frame_arrives_as_several()
    {
        var hub = new RecordingAlertHub();

        var alarms = new List<Alert>();
        for (var i = 0; i <= SignalRAlertNotifier.MaxBatchSize; i++)
            alarms.Add(Fired($"a{i}", $"plant/{i}/temp"));

        await new SignalRAlertNotifier(hub.Context).RaisedAsync(alarms);

        var frames = hub.Frames(SignalRAlertNotifier.AlertsRaised);

        Assert.Equal(2, frames.Count);
        Assert.Equal(SignalRAlertNotifier.MaxBatchSize, frames[0].Count);
        Assert.Single(frames[1]);

        // Split, not sampled: every alarm still arrives, and in the order it was given.
        Assert.Equal("a0", frames[0][0].Id);
        Assert.Equal($"a{SignalRAlertNotifier.MaxBatchSize}", frames[1][0].Id);
    }

    // The panel shows a sample so a person can see what arrived; it does not need the whole body,
    // and a retained 2 MB JSON document on a hub frame is a console that stops drawing. The
    // outgoing webhook and publish bodies carry four kilobytes — this is the screen's limit.
    [Fact]
    public async Task The_sample_the_console_gets_is_the_clipped_one()
    {
        var hub = new RecordingAlertHub();

        await new SignalRAlertNotifier(hub.Context)
            .RaisedAsync([Fired(sample: new string('x', AlertDto.SampleLimit * 4))]);

        var alert = Assert.Single(hub.Frame(SignalRAlertNotifier.AlertsRaised));

        Assert.NotNull(alert.Sample);
        Assert.Equal(AlertDto.SampleLimit, alert.Sample.Length);
    }

    /// <summary>Captures what reached the hub, kept apart by which method carried it.</summary>
    // SendAsync is an extension method, so the substitute has to stand in for the SendCoreAsync
    // underneath it — the same shape RecordingHub uses in MessageBatchingTests.
    private sealed class RecordingAlertHub
    {
        private readonly List<(string Method, object?[] Arguments)> _sends = [];

        public RecordingAlertHub()
        {
            var proxy = Substitute.For<IClientProxy>();
            proxy
                .SendCoreAsync(Arg.Any<string>(), Arg.Any<object?[]>(), Arg.Any<CancellationToken>())
                .Returns(call =>
                {
                    // NSubstitute types Arg<object?[]>() as nullable, and the list does not. The bang is the
                    // honest end of it: SendCoreAsync is never called with a null argument array.
                    _sends.Add((call.ArgAt<string>(0), call.Arg<object?[]>()!));

                    return Task.CompletedTask;
                });

            var clients = Substitute.For<IHubClients>();
            clients.All.Returns(proxy);

            Context = Substitute.For<IHubContext<MqttHub>>();
            Context.Clients.Returns(clients);
        }

        public IHubContext<MqttHub> Context { get; }

        public bool SaidNothing => _sends.Count == 0;

        /// <summary>Every frame a batch method sent, in order.</summary>
        public IReadOnlyList<IReadOnlyList<AlertDto>> Frames(string method) =>
            [.. _sends.Where(sent => sent.Method == method).Select(sent => (AlertDto[])sent.Arguments[0]!)];

        /// <summary>The one frame a method sent, asserting that there was exactly one.</summary>
        public IReadOnlyList<AlertDto> Frame(string method) => Assert.Single(Frames(method));

        /// <summary>The arguments of every call to a method that does not carry a batch.</summary>
        public IReadOnlyList<object?> Arguments(string method) =>
            [.. _sends.Where(sent => sent.Method == method).SelectMany(sent => sent.Arguments)];
    }
}
