namespace MQFaker.Api.Contracts;

public record SubscribeRequestDto(string TopicFilter, int Qos);
