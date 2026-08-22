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
