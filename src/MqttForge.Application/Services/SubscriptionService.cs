using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Services;

public sealed class SubscriptionService
{
    private readonly IMqttSubscriber _subscriber;

    public SubscriptionService(IMqttSubscriber subscriber) => _subscriber = subscriber;

    public IReadOnlyCollection<string> ActiveFilters => _subscriber.ActiveFilters;

    /// <summary>Every filter that is up, and who asked for it.</summary>
    // The console could not tell its own subscriptions from a rule's, so a rule's filter wore an
    // × that offered to remove it — and pressing it wrote 'Unsubscribed' about a subscription
    // that was still up, because the subscriber only drops a filter when its last owner lets go.
    public IReadOnlyCollection<ActiveFilter> Filters => _subscriber.Filters;

    public Task SubscribeAsync(SubscriptionRequest request, CancellationToken ct) =>
        _subscriber.SubscribeAsync([request], ct);

    public Task SubscribeAsync(IReadOnlyList<SubscriptionRequest> requests, CancellationToken ct) =>
        _subscriber.SubscribeAsync(requests, ct);

    public Task UnsubscribeAsync(string topicFilter, CancellationToken ct) =>
        _subscriber.UnsubscribeAsync(topicFilter, ct);
}
