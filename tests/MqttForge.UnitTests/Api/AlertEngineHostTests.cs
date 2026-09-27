using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;
using MqttForge.Api;
using MqttForge.Application.Alerts;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;
using NSubstitute;

namespace MqttForge.UnitTests.Api;

public class AlertEngineHostTests
{
    private static readonly DateTimeOffset T0 = new(2026, 8, 30, 9, 0, 0, TimeSpan.Zero);

    private readonly FakeTimeProvider _time = new(T0);
    private readonly AlertEngineCore _core = new(new AlertEngineOptions());
    private readonly IAlertRuleStore _rules = Substitute.For<IAlertRuleStore>();
    private readonly IAlertStateStore _state = Substitute.For<IAlertStateStore>();
    private readonly IMqttSubscriber _subscriber = Substitute.For<IMqttSubscriber>();

    public AlertEngineHostTests()
    {
        _rules.LoadAsync(Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new AlertRuleDocument([], false, [])));
        _state.LoadAsync(Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<AlertState?>(null));
        _subscriber.ActiveFilters.Returns([]);
        _subscriber.Filters.Returns([]);
    }

    private AlertEngineHost CreateSut() =>
        new(new AlertEngine(
                _core, _rules, _state,
                Substitute.For<IAlertNotifier>(),
                Substitute.For<IMqttConnectionManager>(),
                _subscriber,
                Substitute.For<ILogger<AlertEngine>>(),
                _time),
            _core, _state, new RecordingLogger<AlertEngineHost>());

    [Fact]
    public async Task Starting_the_host_starts_the_engine()
    {
        var sut = CreateSut();

        await sut.StartAsync(CancellationToken.None);
        await sut.StopAsync(CancellationToken.None);

        await _rules.Received(1).LoadAsync(Arg.Any<CancellationToken>());
        await _state.Received(1).LoadAsync(Arg.Any<CancellationToken>());
    }

    // The decision this class exists for. AlertEngineCore has no lock because the pump is its
    // only writer; capturing it while the pump is still turning reads a half-applied tick, and
    // the file that is meant to carry a restart would carry a state that never existed.
    [Fact]
    public async Task The_state_is_captured_only_after_the_pump_has_stopped()
    {
        var sut = CreateSut();
        var pumpWasFinished = false;

        _state.SaveAsync(Arg.Any<AlertState>(), Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                pumpWasFinished = sut.ExecuteTask is { IsCompleted: true };
                return Task.CompletedTask;
            });

        await sut.StartAsync(CancellationToken.None);
        await sut.StopAsync(CancellationToken.None);

        await _state.Received(1).SaveAsync(Arg.Any<AlertState>(), Arg.Any<CancellationToken>());
        Assert.True(pumpWasFinished, "the state was captured while the pump was still running");
    }

    // A host that never ran holds an empty core, and an empty core written to disk is every
    // active alert deleted — including the ones a restart was supposed to hand back. This is the
    // only guard on _owns, because it is the only case where the engine really did not start.
    [Fact]
    public async Task A_host_that_was_never_started_writes_nothing()
    {
        await CreateSut().StopAsync(CancellationToken.None);

        await _state.DidNotReceive().SaveAsync(Arg.Any<AlertState>(), Arg.Any<CancellationToken>());
    }

    // The engine swallows a rules file it cannot open — starting deaf and saying so beats failing
    // to start — so the host does take ownership, and the empty core it holds is the honest state
    // to hand on: no rule in it means no alert in it either.
    [Fact]
    public async Task A_rules_file_that_cannot_be_opened_does_not_fault_the_host()
    {
        _rules.LoadAsync(Arg.Any<CancellationToken>())
            .Returns(Task.FromException<AlertRuleDocument>(new IOException("disk gone")));
        var sut = CreateSut();

        await sut.StartAsync(CancellationToken.None);
        var exception = await Record.ExceptionAsync(() => sut.StopAsync(CancellationToken.None));

        Assert.Null(exception);
        Assert.False(sut.ExecuteTask?.IsFaulted);
    }

    // Shutdown is the one moment where a throw has nowhere useful to go. A full disk is a reason
    // to lose the handover, not a reason for the process to end badly.
    [Fact]
    public async Task A_state_store_that_cannot_write_does_not_break_the_shutdown()
    {
        _state.SaveAsync(Arg.Any<AlertState>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromException(new IOException("disk full")));
        var sut = CreateSut();

        await sut.StartAsync(CancellationToken.None);
        var exception = await Record.ExceptionAsync(() => sut.StopAsync(CancellationToken.None));

        Assert.Null(exception);
    }

    [Fact]
    public async Task Stopping_twice_writes_the_state_once()
    {
        var sut = CreateSut();

        await sut.StartAsync(CancellationToken.None);
        await sut.StopAsync(CancellationToken.None);
        await sut.StopAsync(CancellationToken.None);

        await _state.Received(1).SaveAsync(Arg.Any<AlertState>(), Arg.Any<CancellationToken>());
    }

    // Stopping_twice_writes_the_state_once awaits its two calls one after the other, so it cannot
    // tell a shared hand-over from a race that happened to land safely — the second call there
    // never starts until the first has already returned. WebApplicationFactory's two stop chains
    // (dotnet/aspnetcore #40271, #50622) do not behave that way: both can reach StopAsync while
    // the other is still in flight, on different threads. This test holds SaveAsync open on a gate
    // so both calls are genuinely overlapping — neither has returned — while the one save is still
    // running, and only then lets it finish.
    [Fact]
    public async Task Concurrent_stops_wait_for_the_one_save_and_it_runs_once()
    {
        var sut = CreateSut();
        var gate = new TaskCompletionSource();
        var saveCalls = 0;

        _state.SaveAsync(Arg.Any<AlertState>(), Arg.Any<CancellationToken>())
            .Returns(async _ =>
            {
                Interlocked.Increment(ref saveCalls);
                await gate.Task;
            });

        await sut.StartAsync(CancellationToken.None);

        // Not awaited between them, on purpose: this is what makes the two calls overlap rather
        // than run one after the other.
        var first = sut.StopAsync(CancellationToken.None);
        var second = sut.StopAsync(CancellationToken.None);

        await Task.Delay(TimeSpan.FromMilliseconds(50));

        Assert.False(first.IsCompleted, "a stop returned before the hand-over it shares had finished");
        Assert.False(second.IsCompleted, "a stop returned before the hand-over it shares had finished");

        gate.SetResult();
        await Task.WhenAll(first, second);

        Assert.Equal(1, saveCalls);
        await _state.Received(1).SaveAsync(Arg.Any<AlertState>(), Arg.Any<CancellationToken>());
    }
}
