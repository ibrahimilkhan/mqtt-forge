namespace MQFaker.Domain.Exceptions;

// Known failure states of MQTT operations; Infrastructure translates
// library-specific exceptions into these, and Api maps them to HTTP statuses.
public abstract class MqttOperationException : Exception
{
    protected MqttOperationException(string message, Exception? inner = null)
        : base(message, inner) { }
}

// Broker unreachable, connection refused, or authentication failed
public sealed class BrokerUnreachableException : MqttOperationException
{
    public BrokerUnreachableException(string message, Exception? inner = null)
        : base(message, inner) { }
}

// The operation requires an active connection, but there is none
public sealed class NotConnectedException : MqttOperationException
{
    public NotConnectedException(string message, Exception? inner = null)
        : base(message, inner) { }
}

// The broker or the protocol itself refused this specific message - topic or payload too
// large - independent of whether the connection is otherwise healthy
public sealed class MessageRejectedException : MqttOperationException
{
    public MessageRejectedException(string message, Exception? inner = null)
        : base(message, inner) { }
}
