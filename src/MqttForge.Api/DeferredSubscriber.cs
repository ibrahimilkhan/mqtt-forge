using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.Api;

/// <summary>
/// The subscriber the alert engine is given: the real one, fetched the first time the engine
/// actually subscribes something rather than when the engine is built.
/// </summary>
// This exists to open one ring, and only one. MqttnetSubscriber is constructed with an
// IMessageNotifier; that notifier is now FanOutMessageNotifier; the fan-out is constructed with
// AlertEngine; and AlertEngine is constructed with a subscriber. Every edge in that ring is a
// real dependency — the engine genuinely does subscribe its rules' filters, and the subscriber
// genuinely does hand its messages to the fan-out — so none of them can simply be deleted.
//
// The ring is cut where it costs nothing. Of the four objects, the engine is the only one that
// does not need what it is holding until long after construction: it subscribes when it starts,
// which is a hosted service later, and never touches the subscriber before that. Deferring the
// other direction instead — a lazily-resolved AlertEngine inside the fan-out — would have put an
// indirection on the arrival path, which every single message travels.
//
// Worth knowing what the alternative looks like: the container cannot see this ring, because it
// runs through factory registrations it does not analyse, so it does not report a circular
// dependency. It walks the ring instead, until the stack ends — and a StackOverflowException
// cannot be caught, so the symptom is a host process that vanishes rather than an error anyone
// can read. AlertContainerTests.Building_the_host_does_not_walk_the_notifier_ring_forever is the
// guard, and it is a guard that dies loudly rather than failing quietly.
public sealed class DeferredSubscriber : IMqttSubscriber
{
    private readonly IServiceProvider _services;

    public DeferredSubscriber(IServiceProvider services) => _services = services;

    // Resolved every time rather than cached in a field. The registration is a singleton, so this
    // is a dictionary lookup returning the same object, and a cache here would only add a second
    // place where 'which subscriber' could be answered — with a null to check on the way.
    private IMqttSubscriber Subscriber => _services.GetRequiredService<IMqttSubscriber>();

    public IReadOnlyCollection<string> ActiveFilters => Subscriber.ActiveFilters;

    public IReadOnlyCollection<ActiveFilter> Filters => Subscriber.Filters;

    public Task SubscribeAsync(
        IReadOnlyList<SubscriptionRequest> requests, CancellationToken ct,
        SubscriptionOwner owner = SubscriptionOwner.Console) =>
        Subscriber.SubscribeAsync(requests, ct, owner);

    public Task UnsubscribeAsync(
        string topicFilter, CancellationToken ct,
        SubscriptionOwner owner = SubscriptionOwner.Console) =>
        Subscriber.UnsubscribeAsync(topicFilter, ct, owner);
}
