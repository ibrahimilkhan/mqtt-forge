using System.Net.Sockets;
using System.Security.Authentication;
using MQFaker.Domain.Enums;
using MQFaker.Infrastructure.Mqtt;
using MQTTnet;
using MQTTnet.Adapter;
using MQTTnet.Exceptions;
using Xunit;

namespace MQFaker.UnitTests.Infrastructure;

public class BrokerFailureClassifierTests
{
    [Theory]
    [InlineData(SocketError.ConnectionRefused, BrokerFailureReason.Refused)]
    [InlineData(SocketError.HostNotFound, BrokerFailureReason.HostNotFound)]
    [InlineData(SocketError.NoData, BrokerFailureReason.HostNotFound)]
    [InlineData(SocketError.TryAgain, BrokerFailureReason.NameLookupFailed)]
    [InlineData(SocketError.NoRecovery, BrokerFailureReason.NameLookupFailed)]
    [InlineData(SocketError.NetworkUnreachable, BrokerFailureReason.Unreachable)]
    [InlineData(SocketError.HostUnreachable, BrokerFailureReason.Unreachable)]
    [InlineData(SocketError.NetworkDown, BrokerFailureReason.Unreachable)]
    [InlineData(SocketError.HostDown, BrokerFailureReason.Unreachable)]
    [InlineData(SocketError.AddressNotAvailable, BrokerFailureReason.Unreachable)]
    [InlineData(SocketError.AddressFamilyNotSupported, BrokerFailureReason.Unreachable)]
    [InlineData(SocketError.AccessDenied, BrokerFailureReason.BlockedLocally)]
    [InlineData(SocketError.TimedOut, BrokerFailureReason.Timeout)]
    [InlineData(SocketError.ConnectionReset, BrokerFailureReason.ConnectionLost)]
    [InlineData(SocketError.ConnectionAborted, BrokerFailureReason.ConnectionLost)]
    [InlineData(SocketError.NetworkReset, BrokerFailureReason.ConnectionLost)]
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

        Assert.Equal(BrokerFailureReason.TlsFailed, BrokerFailureClassifier.Classify(exception, useTls: true));
    }

    // A plaintext broker answers a TLS hello by closing the socket, and .NET reports that as a
    // bare IOException. Only the caller's own setting says TLS was in play.
    [Fact]
    public void Classify_reads_a_port_that_does_not_speak_tls()
    {
        var exception = new MqttCommunicationException(
            new IOException("Received an unexpected EOF or 0 bytes from the transport stream."));

        Assert.Equal(BrokerFailureReason.TlsNotOffered, BrokerFailureClassifier.Classify(exception, useTls: true));
    }

    // Bytes came back that are not MQTT. A TLS listener answering plaintext does this with an
    // alert record — but so does an HTTP server, measured against a real one, so the answer
    // cannot claim TLS. It says "not a broker" and lets the sentence raise TLS as one option.
    [Fact]
    public void Classify_does_not_read_tls_into_a_peer_that_simply_talked_nonsense()
    {
        var exception = new MqttConnectingFailedException(
            "Error while authenticating.",
            new MqttProtocolViolationException("Property ID '46' is not supported"));

        Assert.Equal(BrokerFailureReason.NoMqttResponse, BrokerFailureClassifier.Classify(exception, useTls: false));
    }

    // Port open, TCP accepted, nothing MQTT ever came back: wrong port, an HTTP server, a
    // broker that closed on us. MQTTnet flattens all of them into one shape.
    [Fact]
    public void Classify_reads_a_peer_that_never_answered_as_a_broker()
    {
        var exception = new MqttConnectingFailedException(
            "Error while authenticating. Connection closed.",
            new MqttCommunicationException("Connection closed."));

        Assert.Equal(BrokerFailureReason.NoMqttResponse, BrokerFailureClassifier.Classify(exception));
    }

    // Ticking the box must not turn every unclassifiable failure into a TLS story.
    [Fact]
    public void Classify_does_not_blame_tls_without_evidence()
    {
        var exception = new InvalidOperationException("something else entirely");

        Assert.Equal(BrokerFailureReason.Unknown, BrokerFailureClassifier.Classify(exception, useTls: true));
    }

    // TLS can't be at fault before the socket is even open.
    [Fact]
    public void Classify_lets_a_socket_error_outrank_the_tls_hint()
    {
        var exception = new MqttCommunicationException(new SocketException((int)SocketError.ConnectionRefused));

        Assert.Equal(BrokerFailureReason.Refused, BrokerFailureClassifier.Classify(exception, useTls: true));
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
    [InlineData(MqttClientConnectResultCode.BadAuthenticationMethod, BrokerFailureReason.CredentialsRejected)]
    [InlineData(MqttClientConnectResultCode.Banned, BrokerFailureReason.Banned)]
    [InlineData(MqttClientConnectResultCode.ClientIdentifierNotValid, BrokerFailureReason.ClientIdRejected)]
    [InlineData(MqttClientConnectResultCode.ServerUnavailable, BrokerFailureReason.BrokerBusy)]
    [InlineData(MqttClientConnectResultCode.ServerBusy, BrokerFailureReason.BrokerBusy)]
    [InlineData(MqttClientConnectResultCode.ConnectionRateExceeded, BrokerFailureReason.BrokerBusy)]
    [InlineData(MqttClientConnectResultCode.QuotaExceeded, BrokerFailureReason.BrokerBusy)]
    [InlineData(MqttClientConnectResultCode.UseAnotherServer, BrokerFailureReason.BrokerBusy)]
    [InlineData(MqttClientConnectResultCode.ServerMoved, BrokerFailureReason.BrokerBusy)]
    // A 3.1.1 broker answering a v5 CONNECT lands here too: MQTTnet maps return code 1 onto it.
    [InlineData(MqttClientConnectResultCode.UnsupportedProtocolVersion, BrokerFailureReason.ProtocolVersionUnsupported)]
    [InlineData(MqttClientConnectResultCode.MalformedPacket, BrokerFailureReason.BrokerRejected)]
    [InlineData(MqttClientConnectResultCode.ProtocolError, BrokerFailureReason.BrokerRejected)]
    [InlineData(MqttClientConnectResultCode.ImplementationSpecificError, BrokerFailureReason.BrokerRejected)]
    [InlineData(MqttClientConnectResultCode.PacketTooLarge, BrokerFailureReason.BrokerRejected)]
    [InlineData(MqttClientConnectResultCode.UnspecifiedError, BrokerFailureReason.BrokerRejected)]
    public void Classify_reads_the_connack_result_code(
        MqttClientConnectResultCode code, BrokerFailureReason expected)
    {
        Assert.Equal(expected, BrokerFailureClassifier.Classify(code, credentialsSupplied: true));
    }

    // An MQTT 3.1.1 broker answering our MQTT 5 CONNECT. MQTTnet only translates return codes
    // when the CLIENT speaks 3.1.1; on the v5 path it casts the byte straight through, and
    // 1-5 are unused in the v5 space, so they arrive as themselves. Measured against a broker
    // that replies with a v3 CONNACK: all four landed on the generic refusal before this.
    [Theory]
    [InlineData(1, BrokerFailureReason.ProtocolVersionUnsupported)]
    [InlineData(2, BrokerFailureReason.ClientIdRejected)]
    [InlineData(3, BrokerFailureReason.BrokerBusy)]
    [InlineData(4, BrokerFailureReason.CredentialsRejected)]
    [InlineData(5, BrokerFailureReason.CredentialsRejected)]
    public void Classify_reads_a_311_brokers_return_code(int raw, BrokerFailureReason expected)
    {
        Assert.Equal(
            expected,
            BrokerFailureClassifier.Classify((MqttClientConnectResultCode)raw, credentialsSupplied: true));
    }

    [Theory]
    [InlineData(4)]
    [InlineData(5)]
    public void Classify_asks_for_credentials_on_a_311_refusal_too(int raw)
    {
        Assert.Equal(
            BrokerFailureReason.CredentialsRequired,
            BrokerFailureClassifier.Classify((MqttClientConnectResultCode)raw, credentialsSupplied: false));
    }

    // "Wrong password" and "this broker wants a password at all" are the same code on the wire.
    // What tells them apart is whether the user typed one — which only we know.
    [Theory]
    [InlineData(MqttClientConnectResultCode.NotAuthorized)]
    [InlineData(MqttClientConnectResultCode.BadUserNameOrPassword)]
    public void Classify_asks_for_credentials_when_none_were_offered(MqttClientConnectResultCode code)
    {
        Assert.Equal(
            BrokerFailureReason.CredentialsRequired,
            BrokerFailureClassifier.Classify(code, credentialsSupplied: false));
    }

    [Theory]
    [InlineData(MqttClientDisconnectReason.SessionTakenOver, BrokerFailureReason.SessionTakenOver)]
    [InlineData(MqttClientDisconnectReason.NormalDisconnection, BrokerFailureReason.BrokerClosed)]
    [InlineData(MqttClientDisconnectReason.DisconnectWithWillMessage, BrokerFailureReason.BrokerClosed)]
    [InlineData(MqttClientDisconnectReason.UseAnotherServer, BrokerFailureReason.BrokerClosed)]
    [InlineData(MqttClientDisconnectReason.ServerMoved, BrokerFailureReason.BrokerClosed)]
    [InlineData(MqttClientDisconnectReason.ServerShuttingDown, BrokerFailureReason.BrokerShuttingDown)]
    [InlineData(MqttClientDisconnectReason.AdministrativeAction, BrokerFailureReason.Kicked)]
    [InlineData(MqttClientDisconnectReason.NotAuthorized, BrokerFailureReason.CredentialsRejected)]
    [InlineData(MqttClientDisconnectReason.ServerBusy, BrokerFailureReason.BrokerBusy)]
    [InlineData(MqttClientDisconnectReason.MessageRateTooHigh, BrokerFailureReason.BrokerBusy)]
    [InlineData(MqttClientDisconnectReason.KeepAliveTimeout, BrokerFailureReason.Timeout)]
    [InlineData(MqttClientDisconnectReason.MaximumConnectTime, BrokerFailureReason.Timeout)]
    [InlineData(MqttClientDisconnectReason.TopicAliasInvalid, BrokerFailureReason.BrokerRejected)]
    [InlineData(MqttClientDisconnectReason.PacketTooLarge, BrokerFailureReason.BrokerRejected)]
    [InlineData(MqttClientDisconnectReason.ProtocolError, BrokerFailureReason.BrokerRejected)]
    public void Classify_reads_the_disconnect_reason(
        MqttClientDisconnectReason reason, BrokerFailureReason expected)
    {
        Assert.Equal(expected, BrokerFailureClassifier.Classify(Dropped(reason)));
    }

    // MQTTnet never resets its disconnect-reason field between attempts, so an UnspecifiedError
    // with no exception is a leftover from an earlier failure, not an answer about this one.
    [Fact]
    public void Classify_does_not_trust_an_unspecified_disconnect_code()
    {
        Assert.Equal(
            BrokerFailureReason.ConnectionLost,
            BrokerFailureClassifier.Classify(Dropped(MqttClientDisconnectReason.UnspecifiedError)));
    }

    // The reason code says nothing when the link died under MQTTnet rather than being
    // closed by the broker; the exception it hands over is where the cause actually is.
    [Fact]
    public void Classify_prefers_the_exception_a_dropped_link_carries()
    {
        var dropped = Dropped(
            MqttClientDisconnectReason.NormalDisconnection,
            new MqttCommunicationException(new SocketException((int)SocketError.ConnectionReset)));

        Assert.Equal(BrokerFailureReason.ConnectionLost, BrokerFailureClassifier.Classify(dropped));
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
