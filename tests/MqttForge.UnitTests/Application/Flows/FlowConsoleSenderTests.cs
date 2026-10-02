using MqttForge.Application.Alerts;
using MqttForge.Application.Flows;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using MqttForge.UnitTests.Application.Alerts;

namespace MqttForge.UnitTests.Application.Flows;

// The loop the pump hands the console's pushes to, on its own: what it keeps for a console that is
// slow to take them, and what it tells that console once it does.
public sealed class FlowConsoleSenderTests : IAsyncLifetime
{
    private static readonly DateTimeOffset T0 = new(2026, 9, 26, 9, 0, 0, TimeSpan.Zero);

    private readonly RecordingFlowNotifier _console = new();
    private readonly RecordingLogger<FlowEngine> _log = new();
    private readonly CancellationTokenSource _stop = new();
    private readonly FlowConsoleSender _sender;
    private Task? _loop;

    public FlowConsoleSenderTests() => _sender = new FlowConsoleSender(_console, _log);

    public Task InitializeAsync()
    {
        _loop = Task.Run(() => _sender.RunAsync(_stop.Token));
        return Task.CompletedTask;
    }

    public async Task DisposeAsync()
    {
        await _stop.CancelAsync();
        await _loop!.WaitAsync(TimeSpan.FromSeconds(10));
        _stop.Dispose();
    }

    private static async Task Until(Func<bool> settled, string what)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(10);

        while (DateTime.UtcNow < deadline)
        {
            if (settled()) return;
            await Task.Delay(5);
        }

        Assert.Fail($"Timed out waiting until {what}.");
    }

    private static FlowDebugEntry Line(int n) => new("f1", "say", T0, FlowDebugEntry.Message, "a/b", $"line {n}");

    private static FlowStatus Picture(int n) => new([new FlowRunStatus($"f{n}", null, [])]);

    private static Alert Alarm(string id) => new(id, "flow-f1-hot", "Watch · Hot", $"plant/{id}/temp", AlertSeverity.Critical,
        FiredAt: T0, LastSeenAt: T0, ResolvedAt: null, ResolvedBy: null, MutedUntil: null, Count: 1,
        Reason: "hot", Value: null, Sample: null, Actions: [new ScreenAction()]);

    private static AlertEvent Up(string id) => new(Alarm(id), Raised: true);

    private static AlertEvent Down(string id) => new(Alarm(id) with { ResolvedAt = T0, ResolvedBy = "clear" }, Raised: false);

    // ---- alarms ----

    // A status is the picture of everything handed over before it, alarms included: sent ahead of
    // them, it would light a node for an alarm the badge has not been told of.
    [Fact]
    public async Task Alarms_go_out_in_their_order_and_ahead_of_the_status_handed_over_after_them()
    {
        _console.Stall = true;
        _sender.Alarms([Up("w")]);
        await Until(() => _console.Held == 1, "the first alarm to be stuck with the console");

        // All of it waiting together once the console takes again: two alarms, a picture, and more.
        _sender.Alarms([Up("x")]);
        _sender.Status(Picture(1));
        _sender.Alarms([Down("x"), Up("y")]);
        _console.Stall = false;

        await Until(() => _console.Told.Count == 5, "the alarms and the picture to be taken");
        Assert.Equal(["raised a", "raised b", "resolved b", "raised c", "status 0"], _console.Told);
        Assert.Equal("f1", Assert.Single(_console.Statuses).Flows.Single().Id);
    }

    [Fact]
    public async Task A_console_that_keeps_up_is_told_of_an_alarm_however_briefly_it_stood()
    {
        _console.Stall = true;
        _sender.Status(Picture(0));
        await Until(() => _console.Held == 1, "the picture to be stuck with the console");

        _sender.Alarms([Up("x"), Down("x")]);
        _console.Stall = false;

        await Until(() => _console.Alarms.Count == 2, "both ends of the alarm to be told");
        Assert.Equal(["raised a", "resolved a"], _console.Alarms);
    }

    // What the console still needs, once too many are waiting: every alarm standing, and the end of
    // every alarm it was told went up. An alarm that went up and came down meanwhile it never saw,
    // and never needs to.
    [Fact]
    public async Task Past_the_bound_the_alarms_that_came_and_went_untold_go_and_the_rest_keep_their_order()
    {
        _sender.Alarms([Up("told-1"), Up("told-2")]);
        await Until(() => _console.Alarms.Count == 2, "the first two alarms to be told");

        _console.Stall = true;
        _sender.Status(Picture(0));
        await Until(() => _console.Held == 1, "the picture to be stuck with the console");

        // One turn's worth: an end, a flood of alarms that each went up and came down, a new one that
        // stands, and the other end. More than the bound, all of it waiting on the stuck picture.
        const int flood = FlowConsoleSender.AlarmEvents / 2 + 50;
        var turn = new List<AlertEvent> { Down("told-1") };
        for (var i = 0; i < flood; i++) turn.AddRange([Up($"brief-{i}"), Down($"brief-{i}")]);
        turn.AddRange([Up("standing"), Down("told-2")]);
        _sender.Alarms(turn);

        _console.Stall = false;

        await Until(() => _console.Alarms.Count == 5, "what the console still needs to be told");
        Assert.Equal(["raised a", "raised b", "resolved a", "raised c", "resolved b"], _console.Alarms);

        // The log, and not the alert history: that keeps the last hundred to end, and a flood this
        // size is thousands.
        Assert.Contains($"{flood} flow alarms went up and came down while the console was not taking what it was sent. " +
                        "It was not told of them; the log was.", _log.Lines.Select(line => line.Message));
    }

    // A bound that holds whatever it is handed. The runtime's own ceiling on standing alarms keeps it
    // from ever getting here — so this hands the sender what no runtime would: ends of alarms it was
    // never told went up, more than the bound of them.
    [Fact]
    public async Task Past_the_bound_whatever_it_is_handed_the_oldest_alarm_events_go_and_are_said()
    {
        _console.Stall = true;
        _sender.Status(Picture(0));
        await Until(() => _console.Held == 1, "the picture to be stuck with the console");

        const int over = 10;
        _sender.Alarms([.. Enumerable.Range(0, FlowConsoleSender.AlarmEvents + over).Select(i => Down($"gone-{i}"))]);
        _console.Stall = false;

        await Until(() => _console.Alarms.Count == FlowConsoleSender.AlarmEvents, "the newest events to be told");
        await Task.Delay(50);

        Assert.Equal(FlowConsoleSender.AlarmEvents, _console.AlarmIds.Count);
        Assert.Equal($"gone-{over}", _console.AlarmIds[0]);
        Assert.Equal($"gone-{FlowConsoleSender.AlarmEvents + over - 1}", _console.AlarmIds[^1]);
        Assert.Contains(_log.Lines, line => line.Message.StartsWith($"The console fell {over} flow alarm events behind"));
    }

    // One batch is taken and sticks. Five more than the queue holds come after it, each two lines and
    // one the pump itself had dropped: the oldest five go, and their fifteen are told as dropped.
    [Fact]
    public async Task Lines_a_stuck_console_could_not_be_kept_for_are_counted_as_dropped_on_the_next_batch_sent()
    {
        _console.Stall = true;
        _sender.Debug([Line(0)], 0);
        await Until(() => _console.Held == 1, "the first batch to be stuck with the console");

        const int batches = FlowConsoleSender.DebugBatches + 5;
        for (var i = 1; i <= batches; i++) _sender.Debug([Line(2 * i), Line(2 * i + 1)], dropped: 1);

        _console.Stall = false;
        await Until(() => _console.Debug.Count + _console.LinesDropped == 1 + batches * 3, "every line to be sent or counted");

        // The stuck batch, then the newest sixteen: the sixth, which starts at line 12, onwards.
        Assert.Equal(["line 0", .. Enumerable.Range(12, 2 * FlowConsoleSender.DebugBatches).Select(n => $"line {n}")],
            _console.Debug.Select(line => line.Text));
        Assert.Equal(5 * 3 + FlowConsoleSender.DebugBatches, _console.LinesDropped);
    }

    [Fact]
    public async Task A_stuck_console_is_sent_the_newest_status_once_it_takes_one_again()
    {
        _console.Stall = true;
        _sender.Status(Picture(1));
        await Until(() => _console.Held == 1, "the first picture to be stuck with the console");

        _sender.Status(Picture(2));
        _sender.Status(Picture(3));
        _console.Stall = false;

        await Until(() => _console.Statuses.Count == 2, "the stuck picture and the newest to be taken");
        Assert.Equal(["f1", "f3"], _console.Statuses.Select(status => status.Flows.Single().Id));
    }

    [Fact]
    public async Task A_send_that_fails_is_said_in_the_log_and_the_next_one_still_goes()
    {
        _console.Fault = new InvalidOperationException("The hub is gone.");
        _sender.Status(Picture(1));
        await Until(() => _console.Failed == 1, "the send to fail");

        _console.Fault = null;
        _sender.Status(Picture(2));

        await Until(() => _console.Statuses.Count == 1, "the next picture to be sent");
        Assert.Contains(_log.Lines, line => line.Message.StartsWith("Could not tell the console"));
    }
}
