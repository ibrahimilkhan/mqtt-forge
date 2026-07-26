using MQFaker.Domain.Models;

namespace MQFaker.Domain.Abstractions;

public interface IMqttSubscriber
{
    IReadOnlyCollection<string> ActiveFilters { get; }
    Task SubscribeAsync(SubscriptionRequest request, CancellationToken ct);
    Task UnsubscribeAsync(string topicFilter, CancellationToken ct);
}
