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
