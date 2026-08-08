using System.Net.Sockets;
using System.Security.Authentication;
using MQFaker.Domain.Enums;
using MQTTnet;
using MQTTnet.Exceptions;

namespace MQFaker.Infrastructure.Mqtt;

// Lives here rather than in Domain because reading a cause means knowing MQTTnet's types
public static class BrokerFailureClassifier
{
    // A connect attempt fails in two shapes: it throws before the broker answers, or it
    // answers with a refusing CONNACK. This overload covers the first.
    public static BrokerFailureReason Classify(Exception exception)
    {
        // MQTTnet wraps the real cause, sometimes more than once, so walk the whole chain
        for (Exception? current = exception; current is not null; current = current.InnerException)
        {
            var reason = current switch
            {
                AuthenticationException => BrokerFailureReason.TlsFailed,
                MqttCommunicationTimedOutException or TimeoutException => BrokerFailureReason.Timeout,
                SocketException socket => FromSocketError(socket.SocketErrorCode),
                _ => BrokerFailureReason.Unknown
            };

            if (reason != BrokerFailureReason.Unknown) return reason;
        }

        return BrokerFailureReason.Unknown;
    }

    // ...and this one the CONNACK the broker sent back to refuse us.
    public static BrokerFailureReason Classify(MqttClientConnectResultCode code) => code switch
    {
        MqttClientConnectResultCode.BadUserNameOrPassword
            or MqttClientConnectResultCode.NotAuthorized
            or MqttClientConnectResultCode.Banned
            or MqttClientConnectResultCode.BadAuthenticationMethod => BrokerFailureReason.CredentialsRejected,

        MqttClientConnectResultCode.ClientIdentifierNotValid => BrokerFailureReason.ClientIdRejected,

        MqttClientConnectResultCode.ServerUnavailable
            or MqttClientConnectResultCode.ServerBusy
            or MqttClientConnectResultCode.ConnectionRateExceeded
            or MqttClientConnectResultCode.QuotaExceeded => BrokerFailureReason.BrokerBusy,

        _ => BrokerFailureReason.Unknown
    };

    // A link that was up and is now down. The reason code only carries meaning when the
    // broker sent a DISCONNECT; when MQTTnet lost the socket itself the exception says more.
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

            MqttClientDisconnectReason.NormalDisconnection
                or MqttClientDisconnectReason.DisconnectWithWillMessage
                or MqttClientDisconnectReason.ServerShuttingDown
                or MqttClientDisconnectReason.AdministrativeAction
                or MqttClientDisconnectReason.UseAnotherServer
                or MqttClientDisconnectReason.ServerMoved => BrokerFailureReason.BrokerClosed,

            MqttClientDisconnectReason.NotAuthorized
                or MqttClientDisconnectReason.BadAuthenticationMethod => BrokerFailureReason.CredentialsRejected,

            MqttClientDisconnectReason.ServerBusy
                or MqttClientDisconnectReason.ConnectionRateExceeded
                or MqttClientDisconnectReason.QuotaExceeded
                or MqttClientDisconnectReason.MessageRateTooHigh => BrokerFailureReason.BrokerBusy,

            MqttClientDisconnectReason.KeepAliveTimeout
                or MqttClientDisconnectReason.MaximumConnectTime => BrokerFailureReason.Timeout,

            _ => BrokerFailureReason.Unknown
        };
    }

    private static BrokerFailureReason FromSocketError(SocketError error) => error switch
    {
        SocketError.ConnectionRefused => BrokerFailureReason.Refused,
        SocketError.HostNotFound or SocketError.NoData or SocketError.TryAgain => BrokerFailureReason.HostNotFound,
        SocketError.NetworkUnreachable or SocketError.HostUnreachable => BrokerFailureReason.Unreachable,
        SocketError.TimedOut => BrokerFailureReason.Timeout,
        _ => BrokerFailureReason.Unknown
    };
}
