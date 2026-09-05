using Microsoft.Extensions.Logging;
using MqttForge.Application.Services;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using Xunit;

namespace MqttForge.UnitTests.Application;

public class ConnectionServiceTests
{
    private readonly IMqttConnectionManager _manager = Substitute.For<IMqttConnectionManager>();
    private readonly IConnectionSettingsStore _store = Substitute.For<IConnectionSettingsStore>();
    private readonly ILogger<ConnectionService> _logger = Substitute.For<ILogger<ConnectionService>>();
    private readonly BrokerConnectionSettings _settings = new("localhost", 1883, "id", null, null, false);

    private ConnectionService CreateSut() => new(_manager, _store, _logger);

    /// <summary>The saved settings, as the store would hand them back.</summary>
    private void Saved(BrokerConnectionSettings settings) =>
        _store.LoadAsync(Arg.Any<CancellationToken>()).Returns(Task.FromResult<BrokerConnectionSettings?>(settings));

    private static BrokerConnectionSettings Dialled(IMqttConnectionManager manager)
    {
        var call = manager.ReceivedCalls().Single(c => c.GetMethodInfo().Name == nameof(IMqttConnectionManager.ConnectAsync));
        return (BrokerConnectionSettings)call.GetArguments()[0]!;
    }

    // The API never sends a password back, so the box is empty every time the panel is filled
    // from what was saved. A reader who pressed Disconnect and Connect again was told their
    // password was wrong about a password they had never typed.
    [Fact]
    public async Task A_password_left_empty_is_the_one_saved_for_the_same_broker_and_user()
    {
        Saved(new BrokerConnectionSettings("localhost", 1883, "id", "forge", "forge-secret", false));

        await CreateSut().ConnectAsync(
            new BrokerConnectionSettings("localhost", 1883, "id", "forge", null, false), CancellationToken.None);

        Assert.Equal("forge-secret", Dialled(_manager).Password);
    }

    [Fact]
    public async Task A_password_that_was_typed_is_never_replaced()
    {
        Saved(new BrokerConnectionSettings("localhost", 1883, "id", "forge", "forge-secret", false));

        await CreateSut().ConnectAsync(
            new BrokerConnectionSettings("localhost", 1883, "id", "forge", "typed", false), CancellationToken.None);

        Assert.Equal("typed", Dialled(_manager).Password);
    }

    // A different login, whose password is not this one.
    [Theory]
    [InlineData("elsewhere", 1883, "forge")]
    [InlineData("localhost", 8883, "forge")]
    [InlineData("localhost", 1883, "someone-else")]
    public async Task A_password_is_not_carried_to_another_broker_or_another_user(
        string host, int port, string username)
    {
        Saved(new BrokerConnectionSettings("localhost", 1883, "id", "forge", "forge-secret", false));

        await CreateSut().ConnectAsync(
            new BrokerConnectionSettings(host, port, "id", username, null, false), CancellationToken.None);

        Assert.Null(Dialled(_manager).Password);
    }

    // No username is a reader connecting anonymously, and sending them a stored password would
    // be dialling as somebody they did not say they were.
    [Fact]
    public async Task An_anonymous_connect_is_sent_no_stored_password()
    {
        Saved(new BrokerConnectionSettings("localhost", 1883, "id", "forge", "forge-secret", false));

        await CreateSut().ConnectAsync(
            new BrokerConnectionSettings("localhost", 1883, "id", null, null, false), CancellationToken.None);

        Assert.Null(Dialled(_manager).Password);
    }

    [Fact]
    public async Task A_certificate_password_left_empty_is_the_one_saved_for_that_certificate()
    {
        var tls = new BrokerTlsSettings(false, null, "/certs/client.pfx", null, "forge", null, null);
        Saved(new BrokerConnectionSettings("localhost", 8883, "id", null, null, true, Tls: tls));

        await CreateSut().ConnectAsync(
            new BrokerConnectionSettings("localhost", 8883, "id", null, null, true,
                Tls: tls with { ClientCertificatePassword = null }),
            CancellationToken.None);

        Assert.Equal("forge", Dialled(_manager).Tls?.ClientCertificatePassword);
    }

    // Settings nobody can read are not a reason to refuse a connection the reader asked for.
    [Fact]
    public async Task An_unreadable_settings_file_does_not_stop_the_dial()
    {
        _store.LoadAsync(Arg.Any<CancellationToken>()).ThrowsAsync(new IOException("locked"));

        var exception = await Record.ExceptionAsync(() => CreateSut().ConnectAsync(
            new BrokerConnectionSettings("localhost", 1883, "id", "forge", null, false), CancellationToken.None));

        Assert.Null(exception);
        await _manager.Received(1).ConnectAsync(Arg.Any<BrokerConnectionSettings>(), Arg.Any<CancellationToken>());
    }

    // One link, one dial. Two consoles pressing Connect in the same second used to send two
    // CONNECTs at the broker, and the second tore down the link the first had just made.
    [Fact]
    public async Task Two_dials_at_once_reach_the_broker_one_after_the_other()
    {
        var inFlight = 0;
        var overlapped = false;
        var release = new TaskCompletionSource();

        _manager.ConnectAsync(Arg.Any<BrokerConnectionSettings>(), Arg.Any<CancellationToken>())
            .Returns(async _ =>
            {
                if (Interlocked.Increment(ref inFlight) > 1) overlapped = true;
                await release.Task;
                Interlocked.Decrement(ref inFlight);
            });

        var sut = CreateSut();
        var first = sut.ConnectAsync(_settings with { ClientId = "one" }, CancellationToken.None);
        var second = sut.ConnectAsync(_settings with { ClientId = "two" }, CancellationToken.None);

        release.SetResult();
        await Task.WhenAll(
            Record.ExceptionAsync(() => first),
            Record.ExceptionAsync(() => second));

        Assert.False(overlapped, "the two dials overlapped at the broker");
        await _manager.Received(2).ConnectAsync(Arg.Any<BrokerConnectionSettings>(), Arg.Any<CancellationToken>());
    }

    // A person dialling supersedes whatever was in flight — most of all the supervisor's redial
    // of a broker they are walking away from.
    [Fact]
    public async Task A_readers_dial_calls_off_the_one_already_running()
    {
        var started = new TaskCompletionSource();
        CancellationToken redialToken = default;
        var calls = 0;

        _manager.ConnectAsync(Arg.Any<BrokerConnectionSettings>(), Arg.Any<CancellationToken>())
            .Returns(async call =>
            {
                var token = call.Arg<CancellationToken>();

                if (Interlocked.Increment(ref calls) == 1)
                {
                    redialToken = token;
                    started.TrySetResult();
                    await Task.Delay(Timeout.Infinite, token);
                }
            });

        var sut = CreateSut();
        var redial = sut.ConnectAsync(_settings, CancellationToken.None, ConnectOrigin.Supervisor);
        await started.Task;

        // The reader dials somewhere else, and the redial gives way rather than being queued behind.
        await sut.ConnectAsync(_settings with { Port = 8883 }, CancellationToken.None);

        await Record.ExceptionAsync(() => redial);

        Assert.True(redialToken.IsCancellationRequested, "the redial should have been called off");
        Assert.Equal(2, calls);
    }

    [Fact]
    public async Task ConnectAsync_connects_via_manager()
    {
        var sut = CreateSut();

        await sut.ConnectAsync(_settings, CancellationToken.None);

        await _manager.Received(1).ConnectAsync(_settings, Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task ConnectAsync_persists_settings_after_successful_connect()
    {
        var sut = CreateSut();

        await sut.ConnectAsync(_settings, CancellationToken.None);

        await _store.Received(1).SaveAsync(_settings, Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task ConnectAsync_does_not_persist_when_connect_throws()
    {
        _manager.ConnectAsync(_settings, Arg.Any<CancellationToken>())
            .Returns(Task.FromException(new InvalidOperationException("broker down")));
        var sut = CreateSut();

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => sut.ConnectAsync(_settings, CancellationToken.None));

        await _store.DidNotReceive().SaveAsync(Arg.Any<BrokerConnectionSettings>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task ConnectAsync_succeeds_even_when_saving_settings_fails()
    {
        _store.SaveAsync(_settings, Arg.Any<CancellationToken>())
            .Returns(Task.FromException(new IOException("disk full")));
        var sut = CreateSut();

        var exception = await Record.ExceptionAsync(() => sut.ConnectAsync(_settings, CancellationToken.None));

        Assert.Null(exception);
        await _manager.Received(1).ConnectAsync(_settings, Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task DisconnectAsync_delegates_to_manager()
    {
        var sut = CreateSut();

        await sut.DisconnectAsync(CancellationToken.None);

        await _manager.Received(1).DisconnectAsync(Arg.Any<CancellationToken>());
    }

    // "Sometimes it reconnects after I disconnect by hand": the supervisor's dial was waiting on
    // the manager's gate, the hang-up got the gate first, and the dial went through after it.
    [Fact]
    public async Task DisconnectAsync_calls_off_a_dial_still_in_flight()
    {
        var dialling = new TaskCompletionSource();
        CancellationToken seen = default;
        _manager.ConnectAsync(Arg.Any<BrokerConnectionSettings>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                seen = call.Arg<CancellationToken>();
                dialling.SetResult();
                return Task.Delay(Timeout.Infinite, seen);
            });
        var sut = CreateSut();

        var dial = sut.ConnectAsync(_settings, CancellationToken.None, ConnectOrigin.Supervisor);
        await dialling.Task;
        await sut.DisconnectAsync(CancellationToken.None);

        await Assert.ThrowsAsync<ConnectAttemptAbortedException>(() => dial);
        Assert.True(seen.IsCancellationRequested);
    }

    [Fact]
    public async Task Only_a_readers_dial_is_counted_as_one()
    {
        var sut = CreateSut();

        await sut.ConnectAsync(_settings, CancellationToken.None);
        await sut.ConnectAsync(_settings, CancellationToken.None, ConnectOrigin.Supervisor);
        await sut.ConnectAsync(_settings, CancellationToken.None, ConnectOrigin.Reader);

        Assert.Equal(2, sut.ReaderDials);
    }

    [Fact]
    public void CurrentState_reflects_manager_state()
    {
        _manager.State.Returns(ConnectionState.Connected);
        var sut = CreateSut();

        Assert.Equal(ConnectionState.Connected, sut.CurrentState);
    }

    [Fact]
    public async Task ConnectAsync_skips_the_manager_when_already_connected_with_identical_settings()
    {
        _manager.State.Returns(ConnectionState.Connected);
        var sut = CreateSut();
        await sut.ConnectAsync(_settings, CancellationToken.None);

        var alreadyConnected = await sut.ConnectAsync(_settings, CancellationToken.None);

        Assert.True(alreadyConnected);
        await _manager.Received(1).ConnectAsync(_settings, Arg.Any<CancellationToken>());
        await _store.Received(1).SaveAsync(_settings, Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task ConnectAsync_reconnects_when_already_connected_but_settings_differ()
    {
        _manager.State.Returns(ConnectionState.Connected);
        var sut = CreateSut();
        await sut.ConnectAsync(_settings, CancellationToken.None);
        var different = _settings with { Host = "otherhost" };

        var alreadyConnected = await sut.ConnectAsync(different, CancellationToken.None);

        Assert.False(alreadyConnected);
        await _manager.Received(1).ConnectAsync(different, Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task CancelAttempt_aborts_an_in_flight_connect()
    {
        var started = new TaskCompletionSource();
        _manager.ConnectAsync(_settings, Arg.Any<CancellationToken>())
            .Returns(call => BlockUntilCancelled(call.Arg<CancellationToken>(), started));
        var sut = CreateSut();

        var connecting = sut.ConnectAsync(_settings, CancellationToken.None);
        await started.Task;
        sut.CancelAttempt();

        await Assert.ThrowsAsync<ConnectAttemptAbortedException>(() => Settle(connecting));
    }

    // The caller's own token going down means the browser left, not that anyone asked to abort;
    // the failure that actually happened is the one worth reporting.
    [Fact]
    public async Task ConnectAsync_reports_the_original_failure_when_the_caller_goes_away()
    {
        using var caller = new CancellationTokenSource();
        _manager.ConnectAsync(_settings, Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                caller.Cancel();
                return Task.FromException(new InvalidOperationException("socket died"));
            });
        var sut = CreateSut();

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => sut.ConnectAsync(_settings, caller.Token));
    }

    [Fact]
    public void CancelAttempt_does_nothing_when_no_attempt_is_in_flight()
    {
        var sut = CreateSut();

        Assert.Null(Record.Exception(() => sut.CancelAttempt()));
    }

    // The attempt disposes its own source on the way out, so a late abort must not touch it.
    [Fact]
    public async Task CancelAttempt_does_nothing_once_the_attempt_has_finished()
    {
        var sut = CreateSut();
        await sut.ConnectAsync(_settings, CancellationToken.None);

        Assert.Null(Record.Exception(() => sut.CancelAttempt()));
    }

    // Abort used to cancel whatever was running, which is right for one console and wrong for
    // two: a reader aborting their own slow dial cancelled the other console's instead, and that
    // console was told its attempt had been aborted though nobody there had touched anything.
    [Fact]
    public async Task An_abort_that_names_another_dial_leaves_the_running_one_alone()
    {
        var started = new TaskCompletionSource();
        _manager.ConnectAsync(Arg.Any<BrokerConnectionSettings>(), Arg.Any<CancellationToken>())
            .Returns(call => BlockUntilCancelled(call.Arg<CancellationToken>(), started));

        var sut = CreateSut();
        var dialling = sut.ConnectAsync(_settings, CancellationToken.None);
        await started.Task;

        // Another console's Abort, naming the dial it started rather than this one.
        Assert.False(sut.CancelAttempt(sut.LastDial - 1));
        Assert.False(dialling.IsCompleted);

        // ...and the one that owns it.
        Assert.True(sut.CancelAttempt(sut.LastDial));
        await Record.ExceptionAsync(() => dialling);
    }

    // An abort with no id is 'whatever is running', which is what Try now and an older console ask.
    [Fact]
    public async Task An_abort_with_no_id_calls_off_whatever_is_running()
    {
        var started = new TaskCompletionSource();
        _manager.ConnectAsync(Arg.Any<BrokerConnectionSettings>(), Arg.Any<CancellationToken>())
            .Returns(call => BlockUntilCancelled(call.Arg<CancellationToken>(), started));

        var sut = CreateSut();
        var dialling = sut.ConnectAsync(_settings, CancellationToken.None);
        await started.Task;

        Assert.True(sut.CancelAttempt());
        await Record.ExceptionAsync(() => dialling);
    }

    private static async Task BlockUntilCancelled(CancellationToken token, TaskCompletionSource started)
    {
        started.SetResult();
        await Task.Delay(Timeout.Infinite, token);
    }

    // An attempt nobody cancelled would otherwise hang the run rather than fail it.
    private static Task Settle(Task attempt) => attempt.WaitAsync(TimeSpan.FromSeconds(5));
}
