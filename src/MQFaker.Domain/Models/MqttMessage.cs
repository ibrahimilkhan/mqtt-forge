namespace MQFaker.Domain.Models;

public record MqttMessage(
    string Topic,
    string Payload,
    int Qos,
    bool Retain,
    DateTimeOffset ReceivedAt);
