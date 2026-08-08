using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
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

    // For the cases about a password being wrong, as opposed to missing
    private BrokerConnectionSettings WithPassword => _settings with { Username = "someone", Password = "wrong" };

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
            _notifier.NotifyStateChangedAsync(ConnectionState.Connecting, Arg.Any<BrokerFailure?>());
            _notifier.NotifyStateChangedAsync(ConnectionState.Connected, Arg.Any<BrokerFailure?>());
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
        await _notifier.Received(1).NotifyStateChangedAsync(ConnectionState.Faulted, Arg.Any<BrokerFailure?>());
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
            () => sut.ConnectAsync(WithPassword, CancellationToken.None));

        Assert.Equal(BrokerFailureReason.CredentialsRejected, error.Reason);
        Assert.Equal(ConnectionState.Faulted, sut.State);
        await _notifier.Received(1).NotifyStateChangedAsync(ConnectionState.Faulted, Arg.Any<BrokerFailure?>());
    }

    [Fact]
    public async Task ConnectAsync_reports_disconnected_when_the_caller_cancels()
    {
        using var caller = new CancellationTokenSource();
        _client.ConnectAsync(Arg.Any<MqttClientOptions>(), Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                caller.Cancel();
                return Task.FromException<MqttClientConnectResult>(new OperationCanceledException());
            });
        var sut = CreateSut();

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => sut.ConnectAsync(_settings, caller.Token));

        Assert.Equal(ConnectionState.Disconnected, sut.State);
        Assert.Null(sut.Failure);
    }

    // MQTTnet only honours its own Timeout when the caller passes an uncancellable token, and
    // ASP.NET always passes a cancellable one — so without a deadline of our own the attempt
    // runs until the OS gives up, about 75 seconds on macOS.
    [Fact]
    public async Task ConnectAsync_faults_with_a_timeout_when_the_attempt_outlives_our_deadline()
    {
        _client.ConnectAsync(Arg.Any<MqttClientOptions>(), Arg.Any<CancellationToken>())
            .Returns(async call =>
            {
                await Task.Delay(Timeout.Infinite, call.Arg<CancellationToken>());
                return Connack(MqttClientConnectResultCode.Success);
            });
        var sut = new MqttnetConnectionManager(
            new MqttnetClientProvider(_client), _notifier, TimeSpan.FromMilliseconds(50));

        var error = await Assert.ThrowsAsync<BrokerUnreachableException>(
            () => sut.ConnectAsync(_settings, CancellationToken.None));

        Assert.Equal(BrokerFailureReason.Timeout, error.Reason);
        Assert.Equal(ConnectionState.Faulted, sut.State);
    }

    // MQTTnet's channel adapter turns SocketError.OperationAborted into a cancellation, so an
    // uncancelled caller seeing one means the socket died, not that anybody asked to stop.
    [Fact]
    public async Task ConnectAsync_does_not_mistake_an_aborted_socket_for_a_cancellation()
    {
        _client.ConnectAsync(Arg.Any<MqttClientOptions>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromException<MqttClientConnectResult>(new OperationCanceledException()));
        var sut = CreateSut();

        var error = await Assert.ThrowsAsync<BrokerUnreachableException>(
            () => sut.ConnectAsync(_settings, CancellationToken.None));

        Assert.Equal(BrokerFailureReason.Timeout, error.Reason);
        Assert.Equal(ConnectionState.Faulted, sut.State);
    }

    [Fact]
    public async Task ConnectAsync_reports_disconnected_when_the_caller_cancels_while_closing_the_previous_link()
    {
        using var caller = new CancellationTokenSource();
        _client.IsConnected.Returns(true);
        // Socket closes in a finally even if DISCONNECT is cancelled — same as any other throw
        _client.DisconnectAsync(Arg.Any<MqttClientDisconnectOptions>(), Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                _client.IsConnected.Returns(false);
                caller.Cancel();
                return Task.FromException(new OperationCanceledException());
            });
        var sut = CreateSut();

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => sut.ConnectAsync(_settings, caller.Token));

        Assert.Equal(ConnectionState.Disconnected, sut.State);
    }

    // MQTTnet fires DisconnectedAsync on the connect-failure path too, from a fire-and-forget
    // Task.Run — so it lands AFTER the attempt has already worked out why it failed. Its reason
    // code is meaningless there (ClientWasConnected is false) and must not overwrite the answer.
    [Fact]
    public async Task A_disconnect_from_a_failed_attempt_does_not_overwrite_the_reason()
    {
        GivenConnectReturns(MqttClientConnectResultCode.BadUserNameOrPassword);
        var sut = CreateSut();
        await Assert.ThrowsAsync<BrokerUnreachableException>(
            () => sut.ConnectAsync(WithPassword, CancellationToken.None));

        RaiseDisconnected(MqttClientDisconnectReason.NormalDisconnection, clientWasConnected: false);

        Assert.Equal(BrokerFailureReason.CredentialsRejected, sut.Failure!.Reason);
    }

    [Fact]
    public async Task A_disconnect_from_a_throwing_attempt_does_not_overwrite_the_reason()
    {
        _client.ConnectAsync(Arg.Any<MqttClientOptions>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromException<MqttClientConnectResult>(
                new MqttCommunicationException(new SocketException((int)SocketError.ConnectionRefused))));
        var sut = CreateSut();
        await Assert.ThrowsAsync<BrokerUnreachableException>(
            () => sut.ConnectAsync(_settings, CancellationToken.None));

        RaiseDisconnected(MqttClientDisconnectReason.NormalDisconnection, clientWasConnected: false);

        Assert.Equal(BrokerFailureReason.Refused, sut.Failure!.Reason);
    }

    // The wire cannot tell "that password is wrong" from "this broker wanted one and got none".
    [Fact]
    public async Task ConnectAsync_says_a_password_is_needed_when_none_was_typed()
    {
        GivenConnectReturns(MqttClientConnectResultCode.NotAuthorized);
        var sut = CreateSut();

        var error = await Assert.ThrowsAsync<BrokerUnreachableException>(
            () => sut.ConnectAsync(_settings, CancellationToken.None));

        Assert.Equal(BrokerFailureReason.CredentialsRequired, error.Reason);
    }

    [Fact]
    public async Task ConnectAsync_says_the_password_is_wrong_when_one_was_typed()
    {
        GivenConnectReturns(MqttClientConnectResultCode.NotAuthorized);
        var sut = CreateSut();

        var error = await Assert.ThrowsAsync<BrokerUnreachableException>(
            () => sut.ConnectAsync(WithPassword, CancellationToken.None));

        Assert.Equal(BrokerFailureReason.CredentialsRejected, error.Reason);
    }

    // .NET discards which certificate rule was broken by the time MQTTnet rethrows, so the
    // manager has to have been watching from inside the validation callback.
    [Fact]
    public async Task ConnectAsync_reports_which_certificate_rule_the_broker_broke()
    {
        _client.ConnectAsync(Arg.Any<MqttClientOptions>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                var options = call.Arg<MqttClientOptions>();
                var channel = (MqttClientTcpOptions)options!.ChannelOptions!;
                var tls = channel.TlsOptions!;
                tls.CertificateValidationHandler!(new MqttClientCertificateValidationEventArgs(
                    certificate: null!, chain: null!,
                    SslPolicyErrors.RemoteCertificateNameMismatch, channel));

                return Task.FromException<MqttClientConnectResult>(
                    new MqttCommunicationException(new AuthenticationException("rejected by the callback")));
            });
        var sut = CreateSut();

        var error = await Assert.ThrowsAsync<BrokerUnreachableException>(
            () => sut.ConnectAsync(_settings with { UseTls = true }, CancellationToken.None));

        Assert.Equal(BrokerFailureReason.TlsCertNameMismatch, error.Reason);
    }

    // A stale observation from a previous attempt must not describe this one.
    [Fact]
    public async Task ConnectAsync_forgets_a_certificate_problem_from_an_earlier_attempt()
    {
        var tlsSettings = _settings with { UseTls = true };
        _client.ConnectAsync(Arg.Any<MqttClientOptions>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                var options = call.Arg<MqttClientOptions>();
                var channel = (MqttClientTcpOptions)options!.ChannelOptions!;
                var tls = channel.TlsOptions!;
                tls.CertificateValidationHandler!(new MqttClientCertificateValidationEventArgs(
                    certificate: null!, chain: null!,
                    SslPolicyErrors.RemoteCertificateNameMismatch, channel));

                return Task.FromException<MqttClientConnectResult>(
                    new MqttCommunicationException(new AuthenticationException("rejected by the callback")));
            });
        var sut = CreateSut();
        await Assert.ThrowsAsync<BrokerUnreachableException>(
            () => sut.ConnectAsync(tlsSettings, CancellationToken.None));

        // Second attempt never reaches a certificate at all
        _client.ConnectAsync(Arg.Any<MqttClientOptions>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromException<MqttClientConnectResult>(
                new MqttCommunicationException(new SocketException((int)SocketError.ConnectionRefused))));

        var error = await Assert.ThrowsAsync<BrokerUnreachableException>(
            () => sut.ConnectAsync(tlsSettings, CancellationToken.None));

        Assert.Equal(BrokerFailureReason.Refused, error.Reason);
    }

    // The console cannot work this out for itself: the saved settings are only written after a
    // SUCCESSFUL connect, so a failed attempt to somewhere else has no record on that side.
    [Fact]
    public async Task ConnectAsync_names_the_endpoint_the_failed_attempt_actually_used()
    {
        GivenConnectReturns(MqttClientConnectResultCode.ServerBusy);
        var sut = CreateSut();
        var elsewhere = _settings with { Host = "elsewhere", Port = 1999, ClientId = "probe", UseTls = true };

        await Assert.ThrowsAsync<BrokerUnreachableException>(
            () => sut.ConnectAsync(elsewhere, CancellationToken.None));

        Assert.Equal(
            new BrokerFailure(BrokerFailureReason.BrokerBusy, "elsewhere", 1999, "probe", UseTls: true),
            sut.Failure);
    }

    [Fact]
    public async Task A_dropped_link_names_the_endpoint_it_was_connected_to()
    {
        GivenConnectSucceeds();
        var sut = CreateSut();
        var elsewhere = _settings with { Host = "elsewhere", Port = 1999, ClientId = "probe" };
        await sut.ConnectAsync(elsewhere, CancellationToken.None);

        _client.IsConnected.Returns(false);
        RaiseDisconnected(MqttClientDisconnectReason.ServerShuttingDown);

        Assert.Equal(
            new BrokerFailure(BrokerFailureReason.BrokerShuttingDown, "elsewhere", 1999, "probe", UseTls: false),
            sut.Failure);
    }

    [Fact]
    public async Task OnDisconnected_reports_why_the_link_died()
    {
        GivenConnectSucceeds();
        var sut = CreateSut();
        await sut.ConnectAsync(_settings, CancellationToken.None);

        _client.IsConnected.Returns(false);
        RaiseDisconnected(MqttClientDisconnectReason.SessionTakenOver);

        Assert.Equal(BrokerFailureReason.SessionTakenOver, sut.Failure!.Reason);
        await _notifier.Received(1)
            .NotifyStateChangedAsync(ConnectionState.Faulted, Arg.Is<BrokerFailure>(f => f!.Reason == BrokerFailureReason.SessionTakenOver));
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

        Assert.Null(sut.Failure);
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

        Assert.Null(sut.Failure);
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
        await _notifier.DidNotReceive().NotifyStateChangedAsync(ConnectionState.Faulted, Arg.Any<BrokerFailure?>());
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
        await _notifier.DidNotReceive().NotifyStateChangedAsync(ConnectionState.Faulted, Arg.Any<BrokerFailure?>());
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
        await _notifier.Received(1).NotifyStateChangedAsync(ConnectionState.Faulted, Arg.Any<BrokerFailure?>());
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
        await _notifier.DidNotReceive().NotifyStateChangedAsync(ConnectionState.Connected, Arg.Any<BrokerFailure?>());
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
        await _notifier.DidNotReceive().NotifyStateChangedAsync(ConnectionState.Faulted, Arg.Any<BrokerFailure?>());
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
        MqttClientDisconnectReason reason = MqttClientDisconnectReason.UnspecifiedError,
        bool clientWasConnected = true,
        Exception? exception = null) =>
        _client.DisconnectedAsync += Raise.Event<Func<MqttClientDisconnectedEventArgs, Task>>(
            new MqttClientDisconnectedEventArgs(
                clientWasConnected: clientWasConnected,
                connectResult: null,
                reason: reason,
                reasonString: null,
                userProperties: null,
                exception: exception));
}
