namespace MqttForge.Api.Contracts;

public record SubscribeRequestDto(string TopicFilter, int Qos);
