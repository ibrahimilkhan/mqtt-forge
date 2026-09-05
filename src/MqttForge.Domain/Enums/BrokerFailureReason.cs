namespace MqttForge.Domain.Enums;

// Why a connect attempt or a live link failed, at the granularity the console can put into a
// sentence. A value earns its place only when it leads to DIFFERENT advice and we can actually
// tell it apart in code; causes a user could not act on differently share one value.
public enum BrokerFailureReason
{
    Unknown,

    // Never got as far as a broker
    HostNotFound,
    NameLookupFailed,
    Unreachable,
    BlockedLocally,
    Refused,
    Timeout,

    // Something answered, but not a broker we could talk to
    NoMqttResponse,

    /// <summary>The socket was accepted and then closed without a word.</summary>
    // Told apart from NoMqttResponse because the advice is different. Something that answers with
    // bytes that are not MQTT is usually the wrong port; something that accepts and then says
    // nothing at all is usually a broker that has as many connections as it will take — Mosquitto
    // does exactly this at max_connections — or one behind a proxy that closed the tunnel. Sending
    // that reader to check the port number is sending them to look at the one thing that was right.
    ClosedWithoutAnswering,
    TlsNotOffered,
    ProtocolVersionUnsupported,

    // Every MQTT version was offered and none was taken. Distinct from the above, which is one
    // version being refused and names the fix; this one has already tried the fix.
    NoSupportedProtocolVersion,

    // The WebSocket half never completed. Something is listening and speaking HTTP, but what it
    // returned was not an upgrade to a WebSocket — nearly always the path, occasionally a proxy
    // or an auth gate in front of the broker.
    WebSocketUpgradeRejected,

    // The encrypted channel could not be established
    TlsFailed,
    TlsCertUntrusted,
    TlsCertExpired,
    TlsCertNameMismatch,

    // The certificate side of a mutual-TLS connection. Kept apart from the broker's own
    // certificate above, because the fix is at the opposite end: these are about ours.
    ClientCertificateRequired,
    ClientCertificateRejected,
    CertificateFileUnreadable,

    // A broker answered, and said no
    CredentialsRequired,
    CredentialsRejected,

    /// <summary>The broker wants an MQTT 5 authentication method rather than a password.</summary>
    // Its own reason because the fix is not a password. A broker answering BadAuthenticationMethod
    // is asking for an AUTH exchange — SCRAM, a cloud's own scheme — that this console does not
    // speak, and a reader told their password was rejected goes and changes a password that was
    // right. Nothing they can type in this panel will connect them.
    AuthenticationMethodUnsupported,
    Banned,
    ClientIdRejected,
    BrokerBusy,
    BrokerRejected,

    // A broker that took us in, and then refused something we asked it to do. Not about who we
    // are — the link was already established, credentials and all — so these must never be worded
    // as an identity problem. A broker with no authentication at all sends them.
    NotPermitted,
    FilterRefused,

    // A link that was up, and is not any more
    ConnectionLost,
    SessionTakenOver,
    BrokerClosed,
    BrokerShuttingDown,
    Kicked
}
