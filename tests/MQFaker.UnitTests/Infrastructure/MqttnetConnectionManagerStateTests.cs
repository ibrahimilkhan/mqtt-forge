using MQFaker.Domain.Abstractions;
using MQFaker.Domain.Enums;
using MQFaker.Domain.Exceptions;
using MQFaker.Domain.Models;
using MQFaker.Infrastructure.Mqtt;
using MQTTnet;
using NSubstitute;
using Xunit;

namespace MQFaker.UnitTests.Infrastructure;

public class MqttnetConnectionManagerStateTests
{
    private readonly IMqttClient _client = Substitute.For<IMqttClient>();
    private readonly IConnectionStateNotifier _notifier = Substitute.For<IConnectionStateNotifier>();
    private readonly BrokerConnectionSettings _settings = new("localhost", 1883, "id", null, null, false);

    private MqttnetConnectionManager CreateSut() => new(new MqttnetClientProvider(_client), _notifier);

    [Fact]
    public async Task ConnectAsync_reports_connecting_then_connected()
    {
        var sut = CreateSut();

        await sut.ConnectAsync(_settings, CancellationToken.None);

        Assert.Equal(ConnectionState.Connected, sut.State);
        Received.InOrder(() =>
        {
            _notifier.NotifyStateChangedAsync(ConnectionState.Connecting);
            _notifier.NotifyStateChangedAsync(ConnectionState.Connected);
        });
    }

    [Fact]
    public async Task ConnectAsync_reports_faulted_when_the_broker_cannot_be_reached()
    {
        _client.ConnectAsync(Arg.Any<MqttClientOptions>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromException<MqttClientConnectResult>(new InvalidOperationException("broker down")));
        var sut = CreateSut();

        await Assert.ThrowsAsync<BrokerUnreachableException>(
            () => sut.ConnectAsync(_settings, CancellationToken.None));

        Assert.Equal(ConnectionState.Faulted, sut.State);
        await _notifier.Received(1).NotifyStateChangedAsync(ConnectionState.Faulted);
    }

    [Fact]
    public async Task DisconnectAsync_reports_disconnected_not_faulted()
    {
        var sut = CreateSut();
        await sut.ConnectAsync(_settings, CancellationToken.None);

        await sut.DisconnectAsync(CancellationToken.None);
        RaiseDisconnected();

        Assert.Equal(ConnectionState.Disconnected, sut.State);
        await _notifier.DidNotReceive().NotifyStateChangedAsync(ConnectionState.Faulted);
    }

    [Fact]
    public async Task An_unexpected_drop_reports_faulted()
    {
        var sut = CreateSut();
        await sut.ConnectAsync(_settings, CancellationToken.None);

        RaiseDisconnected();

        Assert.Equal(ConnectionState.Faulted, sut.State);
        await _notifier.Received(1).NotifyStateChangedAsync(ConnectionState.Faulted);
    }

    // MQTTnet raises this whenever the socket closes, whoever closed it.
    private void RaiseDisconnected() =>
        _client.DisconnectedAsync += Raise.Event<Func<MqttClientDisconnectedEventArgs, Task>>(
            new MqttClientDisconnectedEventArgs(
                clientWasConnected: true,
                connectResult: null,
                reason: MqttClientDisconnectReason.UnspecifiedError,
                reasonString: null,
                userProperties: null,
                exception: null));
}
