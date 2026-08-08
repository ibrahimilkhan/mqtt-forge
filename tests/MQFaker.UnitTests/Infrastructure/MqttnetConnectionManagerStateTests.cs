using System.Net.Sockets;
using MQFaker.Domain.Abstractions;
using MQFaker.Domain.Enums;
using MQFaker.Domain.Exceptions;
using MQFaker.Domain.Models;
using MQFaker.Infrastructure.Mqtt;
using MQTTnet;
using MQTTnet.Exceptions;
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
            _notifier.NotifyStateChangedAsync(ConnectionState.Connecting, Arg.Any<BrokerFailureReason?>());
            _notifier.NotifyStateChangedAsync(ConnectionState.Connected, Arg.Any<BrokerFailureReason?>());
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
        await _notifier.Received(1).NotifyStateChangedAsync(ConnectionState.Faulted, Arg.Any<BrokerFailureReason?>());
    }

    [Fact]
    public async Task ConnectAsync_carries_the_reason_the_attempt_threw()
    {
        _client.ConnectAsync(Arg.Any<MqttClientOptions>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromException<MqttClientConnectResult>(
                new MqttCommunicationException(new SocketException((int)SocketError.ConnectionRefused))));
        var sut = CreateSut();

        var error = await Assert.ThrowsAsync<BrokerUnreachableException>(
            () => sut.ConnectAsync(_settings, CancellationToken.None));

        Assert.Equal(BrokerFailureReason.Refused, error.Reason);
    }

    // MQTTnet returns a refusing CONNACK rather than throwing, so an unchecked result
    // would report a successful connect while the client sits there disconnected.
    [Fact]
    public async Task ConnectAsync_faults_when_the_broker_refuses_the_connack()
    {
        GivenConnectReturns(MqttClientConnectResultCode.BadUserNameOrPassword);
        var sut = CreateSut();

        var error = await Assert.ThrowsAsync<BrokerUnreachableException>(
            () => sut.ConnectAsync(_settings, CancellationToken.None));

        Assert.Equal(BrokerFailureReason.CredentialsRejected, error.Reason);
        Assert.Equal(ConnectionState.Faulted, sut.State);
        await _notifier.Received(1).NotifyStateChangedAsync(ConnectionState.Faulted, Arg.Any<BrokerFailureReason?>());
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
    public async Task OnDisconnected_reports_why_the_link_died()
    {
        GivenConnectSucceeds();
        var sut = CreateSut();
        await sut.ConnectAsync(_settings, CancellationToken.None);

        _client.IsConnected.Returns(false);
        RaiseDisconnected(MqttClientDisconnectReason.SessionTakenOver);

        Assert.Equal(BrokerFailureReason.SessionTakenOver, sut.FailureReason);
        await _notifier.Received(1)
            .NotifyStateChangedAsync(ConnectionState.Faulted, BrokerFailureReason.SessionTakenOver);
    }

    [Fact]
    public async Task DisconnectAsync_leaves_no_reason_behind()
    {
        GivenConnectSucceeds();
        GivenDisconnectSucceeds();
        var sut = CreateSut();
        await sut.ConnectAsync(_settings, CancellationToken.None);

        await sut.DisconnectAsync(CancellationToken.None);
        RaiseDisconnected();

        Assert.Null(sut.FailureReason);
    }

    [Fact]
    public async Task ConnectAsync_clears_the_reason_the_last_attempt_left()
    {
        GivenConnectReturns(MqttClientConnectResultCode.BadUserNameOrPassword);
        var sut = CreateSut();
        await Assert.ThrowsAsync<BrokerUnreachableException>(
            () => sut.ConnectAsync(_settings, CancellationToken.None));

        GivenConnectSucceeds();
        await sut.ConnectAsync(_settings, CancellationToken.None);

        Assert.Null(sut.FailureReason);
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
        await _notifier.DidNotReceive().NotifyStateChangedAsync(ConnectionState.Faulted, Arg.Any<BrokerFailureReason?>());
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
        await _notifier.DidNotReceive().NotifyStateChangedAsync(ConnectionState.Faulted, Arg.Any<BrokerFailureReason?>());
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
        await _notifier.Received(1).NotifyStateChangedAsync(ConnectionState.Faulted, Arg.Any<BrokerFailureReason?>());
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
                return Task.FromResult(Connack(MqttClientConnectResultCode.Success));
            });

        await sut.ConnectAsync(_settings, CancellationToken.None);

        Assert.Equal(ConnectionState.Faulted, sut.State);
        await _notifier.DidNotReceive().NotifyStateChangedAsync(ConnectionState.Connected, Arg.Any<BrokerFailureReason?>());
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
        await _notifier.DidNotReceive().NotifyStateChangedAsync(ConnectionState.Faulted, Arg.Any<BrokerFailureReason?>());
    }

    // The real client flips IsConnected as part of connecting; a substitute has to be told to.
    private void GivenConnectSucceeds() =>
        _client.ConnectAsync(Arg.Any<MqttClientOptions>(), Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                _client.IsConnected.Returns(true);
                return Task.FromResult(Connack(MqttClientConnectResultCode.Success));
            });

    // A refusing CONNACK leaves the client disconnected, which is why IsConnected stays false.
    private void GivenConnectReturns(MqttClientConnectResultCode code) =>
        _client.ConnectAsync(Arg.Any<MqttClientOptions>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(Connack(code)));

    private static MqttClientConnectResult Connack(MqttClientConnectResultCode code) =>
        new() { ResultCode = code };

    private void GivenDisconnectSucceeds() =>
        _client.DisconnectAsync(Arg.Any<MqttClientDisconnectOptions>(), Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                _client.IsConnected.Returns(false);
                return Task.CompletedTask;
            });

    // MQTTnet raises this whenever the socket closes, whoever closed it.
    private void RaiseDisconnected(
        MqttClientDisconnectReason reason = MqttClientDisconnectReason.UnspecifiedError) =>
        _client.DisconnectedAsync += Raise.Event<Func<MqttClientDisconnectedEventArgs, Task>>(
            new MqttClientDisconnectedEventArgs(
                clientWasConnected: true,
                connectResult: null,
                reason: reason,
                reasonString: null,
                userProperties: null,
                exception: null));
}
