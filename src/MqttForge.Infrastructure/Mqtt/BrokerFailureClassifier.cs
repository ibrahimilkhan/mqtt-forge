using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Authentication;
using MqttForge.Domain.Enums;
using MQTTnet;
using MQTTnet.Exceptions;

namespace MqttForge.Infrastructure.Mqtt;

// Lives here rather than in Domain because reading a cause means knowing MQTTnet's types
public static class BrokerFailureClassifier
{
    // A connection breaks in three shapes: the attempt throws before a broker answers, the
    // broker answers with a refusing CONNACK, or a live link ends. One overload each.
    //
    // useTls is the caller's own setting, not something read off the exception. A plaintext
    // broker answers a TLS hello by closing the socket, which reaches us as a bare IOException
    // naming no cause at all; only the caller knows TLS was in play. It is a hint, never a
    // catch-all — an unclassifiable failure stays Unknown whether or not TLS was ticked.
    //
    // transport is the caller's own too, and for the same reason: a plaintext socket answering
    // a TLS hello only looks the way it does over TCP.
    public static BrokerFailureReason Classify(
        Exception exception, bool useTls = false, MqttTransport transport = MqttTransport.Tcp)
    {
        // MQTTnet wraps the real cause, sometimes more than once, so walk the whole chain
        Exception deepest = exception;

        // An answer from an outer wrapper that a deeper one is allowed to overrule. Only the
        // WebSocket handshake uses it: ClientWebSocket reports a TLS failure as its own refusal
        // to connect, with the certificate error four levels down, and a reader told the
        // handshake was rejected would go looking at the path instead of the certificate.
        BrokerFailureReason? outer = null;

        for (Exception? current = exception; current is not null; current = current.InnerException)
        {
            deepest = current;

            var reason = current switch
            {
                // Nothing has left this machine yet: a file we were pointed at is missing, is
                // not a certificate, or would not open with the password given.
                CertificateFileException => BrokerFailureReason.CertificateFileUnreadable,

                AuthenticationException => BrokerFailureReason.TlsFailed,
                MqttCommunicationTimedOutException or TimeoutException => BrokerFailureReason.Timeout,
                SocketException socket => FromSocketError(socket.SocketErrorCode),

                // Non-MQTT bytes came back. Tempting to read a plaintext one as a TLS listener
                // answering with an alert — but a plain HTTP server produces this too, measured,
                // so all we can honestly say is that whatever answered was not a broker.
                MqttProtocolViolationException => BrokerFailureReason.NoMqttResponse,

                // The handshake ended before it began — the shape a plaintext port makes of a
                // TLS hello. Meaningless without the caller's settings, so gated on both: over a
                // WebSocket the TLS is the WebSocket's own, and a failure there arrives as a
                // WebSocketException instead, so an IOException on that path is something else.
                IOException when useTls && transport == MqttTransport.Tcp =>
                    BrokerFailureReason.TlsNotOffered,

                _ => BrokerFailureReason.Unknown
            };

            if (reason != BrokerFailureReason.Unknown) return reason;

            // The HTTP request that opens a WebSocket came back as something other than a 101.
            // Nearly always the path — a broker mounts its endpoint at /mqtt and a reverse proxy
            // answers everything else with a page — occasionally a proxy or an auth gate in
            // front of the broker. Held rather than returned: when this exception wraps a real
            // cause it is only the messenger, and the measured cases where it does are a
            // refused certificate and a socket that was never opened.
            if (current is WebSocketException) outer ??= BrokerFailureReason.WebSocketUpgradeRejected;
        }

        // MQTTnet collapses "the peer closed on us", "the peer sent nothing" and "the peer was
        // not a broker at all" into one bare communication exception with nothing underneath.
        // Structural, not a message match: every other communication exception wraps a cause.
        //
        // Over a WebSocket the same silence means one layer further in: the upgrade succeeded,
        // so something there does speak WebSocket, and what it is not speaking is MQTT. Both end
        // at the same advice — check what is actually on this port and path — so both say so.
        if (deepest is MqttCommunicationException) return BrokerFailureReason.NoMqttResponse;

        return outer ?? BrokerFailureReason.Unknown;
    }

    // The CONNACK a broker sends to refuse us. credentialsSupplied is ours to know: the wire
    // cannot tell "that password is wrong" from "this broker wanted one and got none".
    public static BrokerFailureReason Classify(
        MqttClientConnectResultCode code, bool credentialsSupplied = true) => code switch
    {
        MqttClientConnectResultCode.BadUserNameOrPassword
            or MqttClientConnectResultCode.NotAuthorized =>
            credentialsSupplied ? BrokerFailureReason.CredentialsRejected : BrokerFailureReason.CredentialsRequired,

        MqttClientConnectResultCode.BadAuthenticationMethod => BrokerFailureReason.CredentialsRejected,
        MqttClientConnectResultCode.Banned => BrokerFailureReason.Banned,
        MqttClientConnectResultCode.ClientIdentifierNotValid => BrokerFailureReason.ClientIdRejected,
        MqttClientConnectResultCode.UnsupportedProtocolVersion => BrokerFailureReason.ProtocolVersionUnsupported,

        // An MQTT 3.1.1 broker answering our MQTT 5 CONNECT. MQTTnet translates return codes
        // only when the CLIENT speaks 3.1.1; on the v5 path it casts the byte straight through.
        // 1-5 are unused in the v5 space, so a v3 refusal arrives as itself.
        (MqttClientConnectResultCode)1 => BrokerFailureReason.ProtocolVersionUnsupported,
        (MqttClientConnectResultCode)2 => BrokerFailureReason.ClientIdRejected,
        (MqttClientConnectResultCode)3 => BrokerFailureReason.BrokerBusy,
        (MqttClientConnectResultCode)4 or (MqttClientConnectResultCode)5 =>
            credentialsSupplied ? BrokerFailureReason.CredentialsRejected : BrokerFailureReason.CredentialsRequired,

        MqttClientConnectResultCode.ServerUnavailable
            or MqttClientConnectResultCode.ServerBusy
            or MqttClientConnectResultCode.ConnectionRateExceeded
            or MqttClientConnectResultCode.QuotaExceeded
            // Told to go elsewhere; without acting on ServerReference this is "not here, not now"
            or MqttClientConnectResultCode.UseAnotherServer
            or MqttClientConnectResultCode.ServerMoved => BrokerFailureReason.BrokerBusy,

        // Everything else is the broker objecting to the CONNECT itself
        _ => BrokerFailureReason.BrokerRejected
    };

    // A link that was up and is now down. The reason code only carries meaning when the broker
    // sent a DISCONNECT; when MQTTnet lost the socket itself the exception says more.
    public static BrokerFailureReason Classify(MqttClientDisconnectedEventArgs dropped)
    {
        if (dropped.Exception is not null)
        {
            var reason = Classify(dropped.Exception);
            if (reason != BrokerFailureReason.Unknown) return reason;
        }

        return dropped.Reason switch
        {
            MqttClientDisconnectReason.SessionTakenOver => BrokerFailureReason.SessionTakenOver,
            MqttClientDisconnectReason.ServerShuttingDown => BrokerFailureReason.BrokerShuttingDown,
            MqttClientDisconnectReason.AdministrativeAction => BrokerFailureReason.Kicked,

            MqttClientDisconnectReason.NormalDisconnection
                or MqttClientDisconnectReason.DisconnectWithWillMessage
                or MqttClientDisconnectReason.UseAnotherServer
                or MqttClientDisconnectReason.ServerMoved => BrokerFailureReason.BrokerClosed,

            // Not an identity problem. By the time a DISCONNECT arrives the broker has already
            // taken us in — CONNACK is where it judges who we are — so this is it refusing
            // something we asked it to do afterwards, almost always a subscription. Wording it
            // as a rejected password is worse than saying nothing: mqtt.hsl.fi takes no
            // credentials at all and answers this way to a wildcard it considers too broad, so
            // the reader was sent to fix a username that does not exist.
            MqttClientDisconnectReason.NotAuthorized => BrokerFailureReason.NotPermitted,

            // The same refusal, from a broker that names what it objected to.
            MqttClientDisconnectReason.TopicFilterInvalid => BrokerFailureReason.FilterRefused,

            // The exception: a broker can only object to how we authenticated if authentication
            // is what we were doing, so this one is about identity wherever it arrives.
            MqttClientDisconnectReason.BadAuthenticationMethod => BrokerFailureReason.CredentialsRejected,

            MqttClientDisconnectReason.ServerBusy
                or MqttClientDisconnectReason.ConnectionRateExceeded
                or MqttClientDisconnectReason.QuotaExceeded
                or MqttClientDisconnectReason.MessageRateTooHigh => BrokerFailureReason.BrokerBusy,

            MqttClientDisconnectReason.KeepAliveTimeout
                or MqttClientDisconnectReason.MaximumConnectTime => BrokerFailureReason.Timeout,

            // MQTTnet never clears this field between attempts, so an unspecified code with no
            // exception is as likely to be an earlier failure's leftover as an answer about
            // this one. All we can honestly say is that the link is gone.
            MqttClientDisconnectReason.UnspecifiedError => BrokerFailureReason.ConnectionLost,

            // The rest are the broker objecting to something we sent
            _ => BrokerFailureReason.BrokerRejected
        };
    }

    private static BrokerFailureReason FromSocketError(SocketError error) => error switch
    {
        SocketError.ConnectionRefused => BrokerFailureReason.Refused,
        SocketError.HostNotFound or SocketError.NoData => BrokerFailureReason.HostNotFound,

        // The resolver itself failed, which is a different fix from a name that does not exist
        SocketError.TryAgain or SocketError.NoRecovery => BrokerFailureReason.NameLookupFailed,

        SocketError.NetworkUnreachable
            or SocketError.HostUnreachable
            or SocketError.NetworkDown
            or SocketError.HostDown
            or SocketError.AddressNotAvailable
            or SocketError.AddressFamilyNotSupported => BrokerFailureReason.Unreachable,

        // A local firewall, sandbox, or entitlement stopped us before the packet left
        SocketError.AccessDenied => BrokerFailureReason.BlockedLocally,

        SocketError.TimedOut => BrokerFailureReason.Timeout,

        // Someone tore the connection down mid-flight — a middlebox, the peer's stack, the network
        SocketError.ConnectionReset
            or SocketError.ConnectionAborted
            or SocketError.NetworkReset => BrokerFailureReason.ConnectionLost,

        _ => BrokerFailureReason.Unknown
    };
}
