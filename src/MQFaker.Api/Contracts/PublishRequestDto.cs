namespace MQFaker.Api.Contracts;

public record PublishRequestDto(string Topic, string Payload, int Qos, bool Retain);
