namespace MqttForge.Domain.Models;

public record MqttMessage(
    string Topic,
    string Payload,
    string PayloadEncoding,
    int Qos,
    bool Retain,
    DateTimeOffset ReceivedAt);
