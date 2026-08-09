using MqttForge.Domain.Models;

namespace MqttForge.Domain.Abstractions;

public interface IMqttSubscriber
{
    IReadOnlyCollection<string> ActiveFilters { get; }

    // A list rather than one at a time: MQTT carries many filters in a single SUBSCRIBE, and the
    // round trip to the broker dwarfs the packet, so sending them one by one is all waiting.
    Task SubscribeAsync(IReadOnlyList<SubscriptionRequest> requests, CancellationToken ct);

    Task UnsubscribeAsync(string topicFilter, CancellationToken ct);
}
