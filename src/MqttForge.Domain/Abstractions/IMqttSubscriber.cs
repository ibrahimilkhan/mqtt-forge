using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.Domain.Abstractions;

public interface IMqttSubscriber
{
    /// <summary>Every filter that is up, whoever asked for it.</summary>
    IReadOnlyCollection<string> ActiveFilters { get; }

    /// <summary>The same filters with who holds each one and when it was granted.</summary>
    // Kept beside ActiveFilters rather than replacing it: the console's GET /api/subscriptions
    // answers "what am I watching" with a list of strings, and that is the whole of what the
    // panel draws. Owners and grant times are the engine's business.
    IReadOnlyCollection<ActiveFilter> Filters { get; }

    // A list rather than one at a time: MQTT carries many filters in a single SUBSCRIBE, and the
    // round trip to the broker dwarfs the packet, so sending them one by one is all waiting.
    //
    // The owner is defaulted so that every caller that predates the alerting engine — the
    // subscription service, and the integration tests that drive a real broker — keeps saying
    // exactly what it always said: this is the console asking.
    Task SubscribeAsync(IReadOnlyList<SubscriptionRequest> requests, CancellationToken ct,
                        SubscriptionOwner owner = SubscriptionOwner.Console);

    /// <summary>
    /// Gives up one owner's claim on a filter. The broker is told only when the last owner lets go.
    /// </summary>
    Task UnsubscribeAsync(string topicFilter, CancellationToken ct,
                          SubscriptionOwner owner = SubscriptionOwner.Console);
}
