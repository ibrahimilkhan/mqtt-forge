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
    public BrokerUnreachableException(string message, Exception? inner = null)
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
