namespace MqttForge.Domain.Models;

public record PublishRequest(string Topic, byte[] Payload, int Qos, bool Retain);
