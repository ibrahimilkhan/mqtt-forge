using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Services;

public sealed class SubscriptionService
{
    private readonly IMqttSubscriber _subscriber;

    public SubscriptionService(IMqttSubscriber subscriber) => _subscriber = subscriber;

    public IReadOnlyCollection<string> ActiveFilters => _subscriber.ActiveFilters;

    public Task SubscribeAsync(SubscriptionRequest request, CancellationToken ct) =>
        _subscriber.SubscribeAsync([request], ct);

    public Task SubscribeAsync(IReadOnlyList<SubscriptionRequest> requests, CancellationToken ct) =>
        _subscriber.SubscribeAsync(requests, ct);

    public Task UnsubscribeAsync(string topicFilter, CancellationToken ct) =>
        _subscriber.UnsubscribeAsync(topicFilter, ct);
}
