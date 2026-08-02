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
        GivenConnectSucceeds();
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
    public async Task ConnectAsync_reports_disconnected_when_the_attempt_is_cancelled()
    {
        _client.ConnectAsync(Arg.Any<MqttClientOptions>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromException<MqttClientConnectResult>(new OperationCanceledException()));
        var sut = CreateSut();

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => sut.ConnectAsync(_settings, CancellationToken.None));

        Assert.Equal(ConnectionState.Disconnected, sut.State);
    }

    [Fact]
    public async Task ConnectAsync_reports_disconnected_when_cancelled_while_closing_the_previous_link()
    {
        _client.IsConnected.Returns(true);
        // Socket closes in a finally even if DISCONNECT is cancelled — same as any other throw
        _client.DisconnectAsync(Arg.Any<MqttClientDisconnectOptions>(), Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                _client.IsConnected.Returns(false);
                return Task.FromException(new OperationCanceledException());
            });
        var sut = CreateSut();

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => sut.ConnectAsync(_settings, CancellationToken.None));

        Assert.Equal(ConnectionState.Disconnected, sut.State);
    }

    [Fact]
    public async Task DisconnectAsync_reports_disconnected_not_faulted()
    {
        GivenConnectSucceeds();
        GivenDisconnectSucceeds();
        var sut = CreateSut();
        await sut.ConnectAsync(_settings, CancellationToken.None);

        await sut.DisconnectAsync(CancellationToken.None);
        RaiseDisconnected();

        Assert.Equal(ConnectionState.Disconnected, sut.State);
        await _notifier.DidNotReceive().NotifyStateChangedAsync(ConnectionState.Faulted);
    }

    [Fact]
    public async Task DisconnectAsync_reports_disconnected_when_the_client_throws()
    {
        GivenConnectSucceeds();
        var sut = CreateSut();
        await sut.ConnectAsync(_settings, CancellationToken.None);

        // Socket closes in a finally even if sending DISCONNECT fails
        _client.DisconnectAsync(Arg.Any<MqttClientDisconnectOptions>(), Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                _client.IsConnected.Returns(false);
                return Task.FromException(new InvalidOperationException("socket already gone"));
            });

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => sut.DisconnectAsync(CancellationToken.None));

        Assert.Equal(ConnectionState.Disconnected, sut.State);
        await _notifier.DidNotReceive().NotifyStateChangedAsync(ConnectionState.Faulted);
    }

    [Fact]
    public async Task OnDisconnected_reports_faulted_when_the_link_dies_unexpectedly()
    {
        GivenConnectSucceeds();
        var sut = CreateSut();
        await sut.ConnectAsync(_settings, CancellationToken.None);

        _client.IsConnected.Returns(false); // the broker or the network dropped it
        RaiseDisconnected();

        Assert.Equal(ConnectionState.Faulted, sut.State);
        await _notifier.Received(1).NotifyStateChangedAsync(ConnectionState.Faulted);
    }

    [Fact]
    public async Task State_reports_faulted_when_the_broker_closes_the_session_right_after_connecting()
    {
        GivenConnectSucceeds();
        var sut = CreateSut();

        // Duplicate client id: broker closes the session before ConnectAsync finishes
        _client.ConnectAsync(Arg.Any<MqttClientOptions>(), Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                _client.IsConnected.Returns(false);
                RaiseDisconnected();
                return Task.FromResult<MqttClientConnectResult>(null!);
            });

        await sut.ConnectAsync(_settings, CancellationToken.None);

        Assert.Equal(ConnectionState.Faulted, sut.State);
        await _notifier.DidNotReceive().NotifyStateChangedAsync(ConnectionState.Connected);
    }

    [Fact]
    public async Task OnDisconnected_does_not_fault_while_the_client_is_connected()
    {
        GivenConnectSucceeds();
        var sut = CreateSut();
        await sut.ConnectAsync(_settings, CancellationToken.None);

        // A stale event from a link a newer attempt already replaced.
        RaiseDisconnected();

        Assert.Equal(ConnectionState.Connected, sut.State);
        await _notifier.DidNotReceive().NotifyStateChangedAsync(ConnectionState.Faulted);
    }

    // The real client flips IsConnected as part of connecting; a substitute has to be told to.
    private void GivenConnectSucceeds() =>
        _client.ConnectAsync(Arg.Any<MqttClientOptions>(), Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                _client.IsConnected.Returns(true);
                return Task.FromResult<MqttClientConnectResult>(null!);
            });

    private void GivenDisconnectSucceeds() =>
        _client.DisconnectAsync(Arg.Any<MqttClientDisconnectOptions>(), Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                _client.IsConnected.Returns(false);
                return Task.CompletedTask;
            });

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
