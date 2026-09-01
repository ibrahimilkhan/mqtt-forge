using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;
using MqttForge.Api;
using MqttForge.Application.Services;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using NSubstitute;

namespace MqttForge.UnitTests.Api;

/// <summary>The five things the ladder gained when it stopped being silent.</summary>
// Its own file rather than another two hundred lines on BrokerLinkSupervisorTests, which is about
// one question — when does it dial — and answers it thoroughly. These are about a different one:
// what does it say it is doing, and what can be said back to it. Same fake clock, same
// one-second steps, same refusal to start the BackgroundService.
public class ReconnectSupervisionTests
{
    private static readonly DateTimeOffset T0 = new(2026, 9, 2, 21, 0, 0, TimeSpan.Zero);

    private readonly FakeTimeProvider _time = new(T0);
    private readonly IMqttConnectionManager _manager = Substitute.For<IMqttConnectionManager>();
    private readonly IConnectionSettingsStore _settingsStore = Substitute.For<IConnectionSettingsStore>();
    private readonly IAlertRuleStore _rules = Substitute.For<IAlertRuleStore>();
    private readonly RecordingLogger<BrokerLinkSupervisor> _log = new();
    private readonly RecordingOption _option = new();
    private readonly RecordingStatus _heard = new();

    private static readonly BrokerConnectionSettings Saved =
        new("broker.local", 1883, "mqttforge", null, null, false);

    private readonly List<int> _attempts = [];

    public ReconnectSupervisionTests()
    {
        _settingsStore.LoadAsync(Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<BrokerConnectionSettings?>(Saved));

        _rules.LoadAsync(Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new AlertRuleDocument([Rule(enabled: true)], false, [])));

        _manager.ConnectAsync(Arg.Any<BrokerConnectionSettings>(), Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                _attempts.Add(Second);
                return Task.FromException(new IOException("broker down"));
            });
    }

    private int Second => (int)(_time.GetUtcNow() - T0).TotalSeconds;

    private BrokerLinkSupervisor CreateSut() =>
        new(new ConnectionService(_manager, _settingsStore, Substitute.For<ILogger<ConnectionService>>()),
            _rules, _log, _time, panel: null, option: _option, notifier: _heard);

    private static AlertRule Rule(bool enabled) =>
        new("r1", "Boiler temperature", enabled, "plant/+/temp", null,
            new ThresholdCondition(ThresholdOp.Gt, 90), null, null, null,
            AlertSeverity.Critical, [new ScreenAction()]);

    /// <summary>A supervisor past start-up, with the attempt start-up made cleared out of the way.</summary>
    private async Task<BrokerLinkSupervisor> WantedAsync()
    {
        var sut = CreateSut();
        await sut.StartUpAsync(CancellationToken.None);
        _attempts.Clear();
        _heard.Clear();

        return sut;
    }

    private async Task PollAsync(BrokerLinkSupervisor sut, int seconds = 1)
    {
        for (var i = 0; i < seconds; i++)
        {
            _time.Advance(BrokerLinkSupervisor.PollInterval);
            await sut.SuperviseAsync(CancellationToken.None);
        }
    }

    /// <summary>A link that came up and then died, which is the only situation any of this is about.</summary>
    private async Task<BrokerLinkSupervisor> DroppedAsync()
    {
        var sut = await WantedAsync();
        _manager.State.Returns(ConnectionState.Faulted);

        return sut;
    }

    // ---- what it says it is doing ----

    [Fact]
    public async Task Nothing_wrong_means_nothing_being_worked_on()
    {
        var sut = await WantedAsync();
        _manager.State.Returns(ConnectionState.Connected);

        await PollAsync(sut, seconds: 5);

        Assert.False(sut.Status.Active);
        Assert.Equal(0, sut.Status.Attempt);
        Assert.Null(sut.Status.NextAttemptAt);
    }

    // The first thing a reader sees, and it is a wait rather than an attempt — the bottom rung is
    // a second long on purpose. What matters here is that the panel can say so before the dial.
    [Fact]
    public async Task A_drop_is_announced_with_the_instant_the_next_try_is_due()
    {
        var sut = await DroppedAsync();

        await PollAsync(sut);

        Assert.True(sut.Status.Active);
        Assert.Equal(0, sut.Status.Attempt);
        Assert.Equal(_time.GetUtcNow().AddSeconds(1), sut.Status.NextAttemptAt);
    }

    // An instant rather than a number of seconds. A count is stale the moment it is serialised;
    // the console has to run its own countdown either way, and it can only do that against a
    // fixed point.
    [Fact]
    public async Task Every_rung_moves_the_instant_the_next_try_is_due()
    {
        var sut = await DroppedAsync();
        var gaps = new List<double>();
        DateTimeOffset? last = null;

        // Long enough to reach the flat rung: 1 + 2 + 4 + 8 + 16 puts the sixth attempt at
        // second 32, and the gap it schedules is the thirty the ladder stays at from there.
        for (var i = 0; i < 40; i++)
        {
            await PollAsync(sut);
            if (sut.Status.NextAttemptAt is not { } at || at == last) continue;

            gaps.Add(Math.Round((at - _time.GetUtcNow()).TotalSeconds));
            last = at;
        }

        // Read at the poll that moved it, not at every poll: in between, the instant stands still
        // while the clock walks towards it, which is exactly what the console's countdown draws.
        Assert.Equal([1, 2, 4, 8, 16, 30], gaps);
    }

    [Fact]
    public async Task Attempts_are_counted_for_the_reader_not_for_the_ladder()
    {
        var sut = await DroppedAsync();

        // The first poll of an outage schedules rather than dials, so the bottom rung lands at
        // second 2, the next at 4, and the 4-second rung after that is still running at 7.
        await PollAsync(sut, seconds: 7);

        Assert.Equal([2, 4], _attempts);
        Assert.Equal(2, sut.Status.Attempt);
    }

    // Once a second for the whole of an outage would be a payload a console has to ignore, and
    // the countdown it draws does not need one — it has an instant to subtract from.
    [Fact]
    public async Task A_poll_that_changed_nothing_says_nothing()
    {
        var sut = await DroppedAsync();

        // Second one schedules the first rung; two through seven are the ladder, and only the
        // polls that actually moved it are worth a word.
        await PollAsync(sut, seconds: 16);

        Assert.All(_heard.Statuses.Zip(_heard.Statuses.Skip(1)), pair => Assert.NotEqual(pair.First, pair.Second));
        Assert.True(_heard.Statuses.Count < 16, $"announced {_heard.Statuses.Count} times in 16 polls");
    }

    [Fact]
    public async Task A_link_that_comes_back_ends_the_outage_it_was_told_about()
    {
        var sut = await DroppedAsync();
        await PollAsync(sut, seconds: 4);
        Assert.True(sut.Status.Active);

        _manager.State.Returns(ConnectionState.Connected);
        await PollAsync(sut);

        Assert.Equal(new ReconnectStatus(true, false, 0, null, false), sut.Status);
    }

    // ---- stopping it ----

    [Fact]
    public async Task Calling_off_an_outage_stops_the_ladder_where_it_stands()
    {
        var sut = await DroppedAsync();
        await PollAsync(sut, seconds: 4);
        var made = _attempts.Count;

        await sut.CancelAsync();
        await PollAsync(sut, seconds: 60);

        Assert.Equal(made, _attempts.Count);
        Assert.True(sut.Status.GaveUp);
        Assert.False(sut.Status.Active);
        Assert.Null(sut.Status.NextAttemptAt);
    }

    // Half of a rung's time is spent inside a 20-second connect timeout, so a cancel that only
    // cleared the schedule would leave the reader watching a Connecting they had just stopped.
    [Fact]
    public async Task Calling_off_an_outage_calls_off_the_dial_in_flight()
    {
        // Held open on purpose. A dial that came back on its own would be racing the cancel, and
        // the race is the thing this test cannot afford to have: it would pass either way.
        var reached = new TaskCompletionSource();
        var release = new TaskCompletionSource();
        var seen = CancellationToken.None;

        // After the sut is standing, never before it. Start-up makes a dial of its own, and a
        // holding dial installed ahead of it holds *that* one — which is a test that waits for
        // its own subject to finish being built.
        var sut = await DroppedAsync();

        _manager.ConnectAsync(Arg.Any<BrokerConnectionSettings>(), Arg.Any<CancellationToken>())
            .Returns(async call =>
            {
                seen = call.Arg<CancellationToken>();
                reached.SetResult();
                await release.Task;

                throw new IOException("broker down");
            });

        var dialling = PollAsync(sut, seconds: 2);
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));

        await sut.CancelAsync();

        Assert.True(seen.IsCancellationRequested);
        release.SetResult();
        await dialling;
    }

    // Per-outage, not permanent. "Stop, I am looking at it" is by far the commoner thing to mean,
    // and a reader who then reconnects by hand has plainly stopped meaning it.
    [Fact]
    public async Task A_link_that_comes_back_re_arms_a_supervisor_that_had_given_up()
    {
        var sut = await DroppedAsync();
        await PollAsync(sut);
        await sut.CancelAsync();

        _manager.State.Returns(ConnectionState.Connected);
        await PollAsync(sut);
        Assert.False(sut.Status.GaveUp);

        _manager.State.Returns(ConnectionState.Faulted);
        await PollAsync(sut, seconds: 4);

        Assert.NotEmpty(_attempts);
        Assert.True(sut.Status.Active);
    }

    // ---- trying now ----

    [Fact]
    public async Task Trying_now_dials_without_waiting_for_the_rung()
    {
        var sut = await DroppedAsync();
        await PollAsync(sut, seconds: 7);
        _attempts.Clear();

        await sut.RetryNowAsync(CancellationToken.None);

        Assert.Single(_attempts);
    }

    // A fresh go at the broker, not the continuation of a climb — so the ladder starts at the
    // bottom again rather than at the thirty seconds it had reached.
    [Fact]
    public async Task Trying_now_starts_the_ladder_again_from_the_bottom()
    {
        var sut = await DroppedAsync();
        await PollAsync(sut, seconds: 31);

        await sut.RetryNowAsync(CancellationToken.None);

        Assert.Equal(_time.GetUtcNow().AddSeconds(1), sut.Status.NextAttemptAt);
    }

    [Fact]
    public async Task Trying_now_un_gives_up()
    {
        var sut = await DroppedAsync();
        await sut.CancelAsync();

        await sut.RetryNowAsync(CancellationToken.None);

        Assert.False(sut.Status.GaveUp);
        Assert.Single(_attempts);
    }

    // A hand on a button rather than a policy: turning supervision off says who decides when to
    // dial, not that dialling is over.
    [Fact]
    public async Task Trying_now_works_with_the_option_off()
    {
        var sut = await DroppedAsync();
        await sut.SetEnabledAsync(false, CancellationToken.None);

        await sut.RetryNowAsync(CancellationToken.None);

        Assert.Single(_attempts);
        // And it is still off, and still not laddering.
        Assert.False(sut.Status.Enabled);
        Assert.Null(sut.Status.NextAttemptAt);
    }

    [Fact]
    public async Task A_dial_that_works_leaves_no_countdown_under_a_live_link()
    {
        var sut = await DroppedAsync();
        _manager.ConnectAsync(Arg.Any<BrokerConnectionSettings>(), Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                _manager.State.Returns(ConnectionState.Connected);
                return Task.CompletedTask;
            });

        await sut.RetryNowAsync(CancellationToken.None);

        Assert.Null(sut.Status.NextAttemptAt);
        Assert.False(sut.Status.Active);
    }

    // ---- the option ----

    [Fact]
    public async Task Supervision_is_on_unless_somebody_said_otherwise()
    {
        var sut = await WantedAsync();

        Assert.True(sut.Status.Enabled);
        Assert.True(BrokerLinkSupervisor.EnabledByDefault);
    }

    [Fact]
    public async Task The_option_is_read_at_start_up()
    {
        _option.Saved = false;

        var sut = CreateSut();
        await sut.StartUpAsync(CancellationToken.None);

        Assert.False(sut.Status.Enabled);
    }

    [Fact]
    public async Task With_the_option_off_a_drop_is_left_alone()
    {
        var sut = await DroppedAsync();
        await sut.SetEnabledAsync(false, CancellationToken.None);

        await PollAsync(sut, seconds: 120);

        Assert.Empty(_attempts);
        Assert.False(sut.Status.Active);
    }

    [Fact]
    public async Task Turning_the_option_off_is_remembered()
    {
        var sut = await WantedAsync();

        await sut.SetEnabledAsync(false, CancellationToken.None);

        Assert.False(_option.Saved);
    }

    // Turning it off mid-outage stands the ladder down; turning it back on starts from the bottom
    // rung rather than from wherever the climb had got to an hour ago.
    [Fact]
    public async Task Turning_the_option_back_on_starts_the_ladder_again_from_the_bottom()
    {
        var sut = await DroppedAsync();
        await PollAsync(sut, seconds: 31);
        await sut.SetEnabledAsync(false, CancellationToken.None);

        await sut.SetEnabledAsync(true, CancellationToken.None);
        await PollAsync(sut);

        Assert.Equal(_time.GetUtcNow().AddSeconds(1), sut.Status.NextAttemptAt);
    }

    // The switch still moved; only the memory of it did not. Failing here would leave the reader
    // with a switch that refuses to move and a link nobody is watching.
    [Fact]
    public async Task A_setting_that_cannot_be_saved_still_takes_effect()
    {
        _option.Throw = new IOException("read-only volume");
        var sut = await WantedAsync();

        await sut.SetEnabledAsync(false, CancellationToken.None);

        Assert.False(sut.Status.Enabled);
        Assert.Contains(_log.Entries, one => one.Level == LogLevel.Warning);
    }

    [Fact]
    public async Task An_unreadable_option_file_leaves_the_default_standing()
    {
        _option.Throw = new IOException("read-only volume");

        var sut = CreateSut();
        await sut.StartUpAsync(CancellationToken.None);

        Assert.True(sut.Status.Enabled);
    }

    // Turning auto-reconnect off is an answer about what happens when a link drops. A container
    // that came up having been told not to reconnect, and therefore never connected at all, would
    // evaluate nothing and say nothing about why.
    [Fact]
    public async Task The_option_does_not_stop_the_one_dial_start_up_makes_for_the_rules()
    {
        _option.Saved = false;

        var sut = CreateSut();
        await sut.StartUpAsync(CancellationToken.None);

        Assert.Single(_attempts);
    }

    // ---- the announcement itself ----

    [Fact]
    public async Task A_hub_that_throws_never_stops_the_supervisor()
    {
        _heard.Throw = new InvalidOperationException("no listeners");
        var sut = await DroppedAsync();

        var exception = await Record.ExceptionAsync(() => PollAsync(sut, seconds: 8));

        Assert.Null(exception);
        Assert.NotEmpty(_attempts);
    }

    [Fact]
    public async Task The_option_is_announced_the_moment_it_is_set()
    {
        var sut = await WantedAsync();

        await sut.SetEnabledAsync(false, CancellationToken.None);

        Assert.False(_heard.Statuses[^1].Enabled);
    }

    private sealed class RecordingOption : IReconnectOptionStore
    {
        public bool? Saved { get; set; }
        public Exception? Throw { get; set; }

        public Task<bool?> LoadAsync(CancellationToken ct) =>
            Throw is not null ? Task.FromException<bool?>(Throw) : Task.FromResult(Saved);

        public Task SaveAsync(bool enabled, CancellationToken ct)
        {
            if (Throw is not null) return Task.FromException(Throw);
            Saved = enabled;

            return Task.CompletedTask;
        }
    }

    private sealed class RecordingStatus : IReconnectStatusNotifier
    {
        public List<ReconnectStatus> Statuses { get; } = [];
        public Exception? Throw { get; set; }

        public void Clear() => Statuses.Clear();

        public Task NotifyReconnectStatusChangedAsync(ReconnectStatus status)
        {
            Statuses.Add(status);

            return Throw is not null ? Task.FromException(Throw) : Task.CompletedTask;
        }
    }
}
