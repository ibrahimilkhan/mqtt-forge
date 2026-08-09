using Microsoft.Extensions.Logging;
using MqttForge.Application.Services;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;
using NSubstitute;
using Xunit;

namespace MqttForge.UnitTests.Application;

public class ConnectionServiceTests
{
    private readonly IMqttConnectionManager _manager = Substitute.For<IMqttConnectionManager>();
    private readonly IConnectionSettingsStore _store = Substitute.For<IConnectionSettingsStore>();
    private readonly ILogger<ConnectionService> _logger = Substitute.For<ILogger<ConnectionService>>();
    private readonly BrokerConnectionSettings _settings = new("localhost", 1883, "id", null, null, false);

    private ConnectionService CreateSut() => new(_manager, _store, _logger);

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

        Assert.Null(Record.Exception(sut.CancelAttempt));
    }

    // The attempt disposes its own source on the way out, so a late abort must not touch it.
    [Fact]
    public async Task CancelAttempt_does_nothing_once_the_attempt_has_finished()
    {
        var sut = CreateSut();
        await sut.ConnectAsync(_settings, CancellationToken.None);

        Assert.Null(Record.Exception(sut.CancelAttempt));
    }

    private static async Task BlockUntilCancelled(CancellationToken token, TaskCompletionSource started)
    {
        started.SetResult();
        await Task.Delay(Timeout.Infinite, token);
    }

    // An attempt nobody cancelled would otherwise hang the run rather than fail it.
    private static Task Settle(Task attempt) => attempt.WaitAsync(TimeSpan.FromSeconds(5));
}
