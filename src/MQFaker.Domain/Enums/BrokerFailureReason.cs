namespace MQFaker.Domain.Enums;

// Why a connect attempt failed, at the granularity the console can put into a sentence.
// Causes the user cannot tell apart share a value; Unknown falls back to the raw message.
public enum BrokerFailureReason
{
    Unknown,
    Refused,
    HostNotFound,
    Unreachable,
    Timeout,
    TlsFailed,
    CredentialsRejected,
    ClientIdRejected,
    BrokerBusy,

    // Only a live link can end these two ways
    SessionTakenOver,
    BrokerClosed
}
