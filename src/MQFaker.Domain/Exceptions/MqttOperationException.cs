using MQFaker.Domain.Enums;

namespace MQFaker.Domain.Exceptions;

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
