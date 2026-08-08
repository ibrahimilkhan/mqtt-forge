using System.Net.Sockets;
using System.Security.Authentication;
using MQFaker.Domain.Enums;
using MQFaker.Infrastructure.Mqtt;
using MQTTnet;
using MQTTnet.Exceptions;
using Xunit;

namespace MQFaker.UnitTests.Infrastructure;

public class BrokerFailureClassifierTests
{
    [Theory]
    [InlineData(SocketError.ConnectionRefused, BrokerFailureReason.Refused)]
    [InlineData(SocketError.HostNotFound, BrokerFailureReason.HostNotFound)]
    [InlineData(SocketError.NoData, BrokerFailureReason.HostNotFound)]
    [InlineData(SocketError.NetworkUnreachable, BrokerFailureReason.Unreachable)]
    [InlineData(SocketError.HostUnreachable, BrokerFailureReason.Unreachable)]
    [InlineData(SocketError.TimedOut, BrokerFailureReason.Timeout)]
    [InlineData(SocketError.NetworkDown, BrokerFailureReason.Unknown)]
    public void Classify_reads_the_socket_error(SocketError error, BrokerFailureReason expected)
    {
        // How MQTTnet's channel adapter hands every socket failure back.
        var exception = new MqttCommunicationException(new SocketException((int)error));

        Assert.Equal(expected, BrokerFailureClassifier.Classify(exception));
    }

    [Fact]
    public void Classify_reads_a_timeout_from_the_communication_exception()
    {
        var exception = new MqttCommunicationTimedOutException();

        Assert.Equal(BrokerFailureReason.Timeout, BrokerFailureClassifier.Classify(exception));
    }

    [Fact]
    public void Classify_reads_a_tls_failure_from_the_authentication_exception()
    {
        var exception = new MqttCommunicationException(
            new AuthenticationException("the remote certificate is invalid"));

        Assert.Equal(BrokerFailureReason.TlsFailed, BrokerFailureClassifier.Classify(exception));
    }

    [Fact]
    public void Classify_walks_the_whole_inner_chain()
    {
        var exception = new InvalidOperationException(
            "outer", new MqttCommunicationException(new SocketException((int)SocketError.ConnectionRefused)));

        Assert.Equal(BrokerFailureReason.Refused, BrokerFailureClassifier.Classify(exception));
    }

    [Fact]
    public void Classify_falls_back_to_unknown_for_an_unrecognised_exception()
    {
        var exception = new InvalidOperationException("something else entirely");

        Assert.Equal(BrokerFailureReason.Unknown, BrokerFailureClassifier.Classify(exception));
    }

    [Theory]
    [InlineData(MqttClientConnectResultCode.BadUserNameOrPassword, BrokerFailureReason.CredentialsRejected)]
    [InlineData(MqttClientConnectResultCode.NotAuthorized, BrokerFailureReason.CredentialsRejected)]
    [InlineData(MqttClientConnectResultCode.Banned, BrokerFailureReason.CredentialsRejected)]
    [InlineData(MqttClientConnectResultCode.BadAuthenticationMethod, BrokerFailureReason.CredentialsRejected)]
    [InlineData(MqttClientConnectResultCode.ClientIdentifierNotValid, BrokerFailureReason.ClientIdRejected)]
    [InlineData(MqttClientConnectResultCode.ServerUnavailable, BrokerFailureReason.BrokerBusy)]
    [InlineData(MqttClientConnectResultCode.ServerBusy, BrokerFailureReason.BrokerBusy)]
    [InlineData(MqttClientConnectResultCode.ConnectionRateExceeded, BrokerFailureReason.BrokerBusy)]
    [InlineData(MqttClientConnectResultCode.QuotaExceeded, BrokerFailureReason.BrokerBusy)]
    [InlineData(MqttClientConnectResultCode.UnsupportedProtocolVersion, BrokerFailureReason.Unknown)]
    public void Classify_reads_the_connack_result_code(
        MqttClientConnectResultCode code, BrokerFailureReason expected)
    {
        Assert.Equal(expected, BrokerFailureClassifier.Classify(code));
    }

    [Theory]
    [InlineData(MqttClientDisconnectReason.SessionTakenOver, BrokerFailureReason.SessionTakenOver)]
    [InlineData(MqttClientDisconnectReason.NormalDisconnection, BrokerFailureReason.BrokerClosed)]
    [InlineData(MqttClientDisconnectReason.ServerShuttingDown, BrokerFailureReason.BrokerClosed)]
    [InlineData(MqttClientDisconnectReason.AdministrativeAction, BrokerFailureReason.BrokerClosed)]
    [InlineData(MqttClientDisconnectReason.NotAuthorized, BrokerFailureReason.CredentialsRejected)]
    [InlineData(MqttClientDisconnectReason.ServerBusy, BrokerFailureReason.BrokerBusy)]
    [InlineData(MqttClientDisconnectReason.KeepAliveTimeout, BrokerFailureReason.Timeout)]
    [InlineData(MqttClientDisconnectReason.TopicAliasInvalid, BrokerFailureReason.Unknown)]
    public void Classify_reads_the_disconnect_reason(
        MqttClientDisconnectReason reason, BrokerFailureReason expected)
    {
        Assert.Equal(expected, BrokerFailureClassifier.Classify(Dropped(reason)));
    }

    // The reason code says nothing when the link died under MQTTnet rather than being
    // closed by the broker; the exception it hands over is where the cause actually is.
    [Fact]
    public void Classify_prefers_the_exception_a_dropped_link_carries()
    {
        var dropped = Dropped(
            MqttClientDisconnectReason.NormalDisconnection,
            new MqttCommunicationException(new SocketException((int)SocketError.TimedOut)));

        Assert.Equal(BrokerFailureReason.Timeout, BrokerFailureClassifier.Classify(dropped));
    }

    // ...unless that exception says nothing either, and the code is the better guess.
    [Fact]
    public void Classify_falls_back_to_the_disconnect_reason_when_the_exception_is_opaque()
    {
        var dropped = Dropped(
            MqttClientDisconnectReason.SessionTakenOver, new InvalidOperationException("no idea"));

        Assert.Equal(BrokerFailureReason.SessionTakenOver, BrokerFailureClassifier.Classify(dropped));
    }

    private static MqttClientDisconnectedEventArgs Dropped(
        MqttClientDisconnectReason reason, Exception? exception = null) =>
        new(clientWasConnected: true, connectResult: null, reason, reasonString: null,
            userProperties: null, exception);
}
