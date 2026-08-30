using MqttForge.Domain.Enums;

namespace MqttForge.Domain.Exceptions;

// Infrastructure translates library exceptions into these; Api maps these to HTTP statuses
public abstract class MqttOperationException : Exception
{
    protected MqttOperationException(string message, Exception? inner = null)
        : base(message, inner) { }
}

// Broker unreachable, connection refused, or authentication failed
public sealed class BrokerUnreachableException : MqttOperationException
{
    // Required, so a failure can't reach the console without saying what went wrong
    public BrokerUnreachableException(BrokerFailureReason reason, string message, Exception? inner = null)
        : base(message, inner) => Reason = reason;

    public BrokerFailureReason Reason { get; }
}

// The user called off a connect attempt that was still in flight. Not a broker fault: nothing
// out there did anything wrong, and there is no reason to report beyond "you stopped it".
public sealed class ConnectAttemptAbortedException : MqttOperationException
{
    public ConnectAttemptAbortedException(string message, Exception? inner = null)
        : base(message, inner) { }
}

public sealed class NotConnectedException : MqttOperationException
{
    public NotConnectedException(string message, Exception? inner = null)
        : base(message, inner) { }
}

// Message itself rejected (e.g. topic/payload too large), independent of connection health
public sealed class MessageRejectedException : MqttOperationException
{
    public MessageRejectedException(string message, Exception? inner = null)
        : base(message, inner) { }
}

// The colour rules could not be written down. Unlike the connection settings, which are saved
// as a convenience beside an action that succeeded, saving is the whole of what the Colours
// panel was asked to do — so this is reported rather than logged and swallowed. In practice it
// is a mount the container cannot write to.
public sealed class RulesNotSavedException : MqttOperationException
{
    public RulesNotSavedException(string message, Exception? inner = null)
        : base(message, inner) { }
}

// The alert rules could not be written down. Not RulesNotSavedException: that one is mapped to
// the words "Could not save the colour rules", and a user who was editing an alert would be told
// about a panel they never opened. Same failure, different sentence, so a different type — and
// because this one is sealed and separate rather than derived, the switch in MqttExceptionHandler
// has no ordering trap either.
public sealed class AlertRulesNotSavedException : MqttOperationException
{
    public AlertRulesNotSavedException(string message, Exception? inner = null)
        : base(message, inner) { }
}

// The alert rules file on disk could not be read, and the caller asked to write over it anyway
// without saying so. Its own type rather than a reused one because the answer the user needs is
// a specific one — "your file is damaged, and this save would have deleted it; say so explicitly
// or repair it first" — and it is the only exception in this file that describes something the
// user is being protected from rather than something that went wrong.
//
// Deliberately not derived from AlertRulesNotSavedException: nothing was attempted, so a handler
// ordering the two by type would report a failed write for a write that never started. Api maps
// this one to 409 + "rulesUnreadable" and that one to its own reason.
public sealed class AlertRulesUnreadableException : MqttOperationException
{
    public AlertRulesUnreadableException(string message, Exception? inner = null)
        : base(message, inner) { }
}
