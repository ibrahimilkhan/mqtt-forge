using MqttForge.Application.Alerts;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Alerts;

// The loop the alert engine's pump hands the console's half to, on its own: what it keeps for a
// console that is slow to take it, and what it tells that console once it does.
public sealed class AlertConsoleSenderTests : IAsyncLifetime
{
    private static readonly DateTimeOffset T0 = new(2026, 9, 27, 9, 0, 0, TimeSpan.Zero);

    private readonly RecordingAlertConsole _console = new();
    private readonly RecordingLogger<AlertEngine> _log = new();
    private readonly CancellationTokenSource _stop = new();
    private readonly AlertConsoleSender _sender;
    private Task? _loop;

    public AlertConsoleSenderTests() => _sender = new AlertConsoleSender(_console, _log);

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

    private static Alert Alert(string id) => new(id, "hot", "Boiler temperature", $"plant/{id}/temp",
        AlertSeverity.Critical, FiredAt: T0, LastSeenAt: T0, ResolvedAt: null, ResolvedBy: null,
        MutedUntil: null, Count: 1, Reason: "94.2 > 90", Value: 94.2, Sample: null, Actions: [new ScreenAction()]);

    private static AlertEvent Up(string id) => new(Alert(id), Raised: true);

    private static AlertEvent Down(string id) => new(Alert(id) with { ResolvedAt = T0, ResolvedBy = "clear" }, Raised: false);

    [Fact]
    public async Task Alerts_waiting_on_a_stuck_console_go_out_in_their_order_once_it_takes_again()
    {
        _console.Stall = true;
        _sender.Alerts([Up("w")]);
        await Until(() => _console.Held == 1, "the first alert to be stuck with the console");

        _sender.Alerts([Up("x")]);
        _sender.Alerts([Down("x"), Up("y")]);
        _console.Stall = false;

        await Until(() => _console.Told.Count == 4, "every alert to be told");
        Assert.Equal(["raised a", "raised b", "resolved b", "raised c"], _console.Told);
    }

    [Fact]
    public async Task A_stuck_console_is_sent_the_newest_drop_total_and_none_it_missed()
    {
        _console.Stall = true;
        _sender.Dropped(3);
        await Until(() => _console.Held == 1, "the first total to be stuck with the console");

        _sender.Dropped(5);
        _sender.Dropped(7);
        _console.Stall = false;

        await Until(() => _console.Dropped.Count == 2, "the stuck total and the newest to be taken");
        Assert.Equal([3, 7], _console.Dropped);
    }

    [Fact]
    public async Task Past_the_bound_what_the_console_never_needed_is_said_once_it_takes_again()
    {
        _console.Stall = true;
        _sender.Alerts([Up("stuck")]);
        await Until(() => _console.Held == 1, "the first alert to be stuck with the console");

        const int flood = 2_100;
        _sender.Alerts([.. Enumerable.Range(0, flood).SelectMany(i => new[] { Up($"brief-{i}"), Down($"brief-{i}") }), Up("standing")]);
        _console.Stall = false;

        await Until(() => _console.Told.Count == 2, "what the console still needs to be told");
        Assert.Equal(["stuck", "standing"], _console.AlertIds);
        Assert.Contains(_log.Lines, line => line.Message.StartsWith($"{flood} alerts went up and came down"));
    }

    [Fact]
    public async Task A_send_that_fails_is_said_in_the_log_and_the_next_one_still_goes()
    {
        _console.Fault = new InvalidOperationException("The hub is gone.");
        _sender.Alerts([Up("a")]);
        await Until(() => _console.Failed == 1, "the send to fail");

        _console.Fault = null;
        _sender.Alerts([Up("b")]);

        await Until(() => _console.Told.Count == 1, "the next alert to be told");
        Assert.Equal("b", Assert.Single(_console.AlertIds));
        Assert.Contains(_log.Lines, line => line.Message.StartsWith("Could not tell the console"));
    }
}
