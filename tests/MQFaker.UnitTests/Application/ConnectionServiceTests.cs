using Microsoft.Extensions.Logging;
using MQFaker.Application.Services;
using MQFaker.Domain.Abstractions;
using MQFaker.Domain.Enums;
using MQFaker.Domain.Models;
using NSubstitute;
using Xunit;

namespace MQFaker.UnitTests.Application;

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
}
