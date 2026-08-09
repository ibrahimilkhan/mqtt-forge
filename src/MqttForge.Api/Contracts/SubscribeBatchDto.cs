namespace MqttForge.Api.Contracts;

// A whole batch in one SUBSCRIBE. The broker round trip costs the same either way, so this is
// what turns "subscribe to 700 filters" from minutes of waiting into a handful of packets.
public record SubscribeBatchDto(IReadOnlyList<SubscribeRequestDto> Filters);
