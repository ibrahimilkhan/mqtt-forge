namespace MQFaker.Domain.Models;

public record PublishRequest(string Topic, string Payload, int Qos, bool Retain);
