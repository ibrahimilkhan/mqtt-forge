namespace MqttForge.Domain.Models;

// The generated record equality compares Payload by reference (byte[] has no value equality),
// so two requests with identical bytes are unequal. Nothing depends on this today.
public record PublishRequest(string Topic, byte[] Payload, int Qos, bool Retain);
