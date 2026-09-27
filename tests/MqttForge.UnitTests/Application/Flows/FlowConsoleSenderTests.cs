using MqttForge.Application.Flows;
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

    private static FlowStatus Picture(int n) => new([new FlowRunStatus($"f{n}", 0, null, [])]);

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
