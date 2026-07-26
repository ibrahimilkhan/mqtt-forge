using System.Collections.Concurrent;
using MQFaker.Domain.Abstractions;
using MQFaker.Domain.Exceptions;
using MQFaker.Domain.Models;
using MQTTnet;
using MQTTnet.Protocol;

namespace MQFaker.Infrastructure.Mqtt;

public sealed class MqttnetSubscriber : IMqttSubscriber
{
    private readonly IMqttClient _client;
    private readonly IMessageNotifier _notifier;
    private readonly ConcurrentDictionary<string, byte> _filters = new();

    public MqttnetSubscriber(MqttnetClientProvider provider, IMessageNotifier notifier)
    {
        _client = provider.Client;
        _notifier = notifier;

        _client.ApplicationMessageReceivedAsync += OnMessageReceivedAsync;
        _client.DisconnectedAsync += OnDisconnectedAsync;
    }

    public IReadOnlyCollection<string> ActiveFilters => _filters.Keys.ToArray();

    public async Task SubscribeAsync(SubscriptionRequest request, CancellationToken ct)
    {
        EnsureConnected();

        await _client.SubscribeAsync(
            new MqttTopicFilterBuilder()
                .WithTopic(request.TopicFilter)
                .WithQualityOfServiceLevel((MqttQualityOfServiceLevel)request.Qos)
                .Build(),
            ct);

        _filters[request.TopicFilter] = 0;
    }

    public async Task UnsubscribeAsync(string topicFilter, CancellationToken ct)
    {
        EnsureConnected();

        await _client.UnsubscribeAsync(topicFilter, ct);
        _filters.TryRemove(topicFilter, out _);
    }

    private void EnsureConnected()
    {
        if (!_client.IsConnected)
            throw new NotConnectedException("Connect to a broker before subscribing.");
    }

    private Task OnMessageReceivedAsync(MqttApplicationMessageReceivedEventArgs e)
    {
        var message = new MqttMessage(
            e.ApplicationMessage.Topic,
            e.ApplicationMessage.ConvertPayloadToString() ?? string.Empty,
            (int)e.ApplicationMessage.QualityOfServiceLevel,
            e.ApplicationMessage.Retain,
            DateTimeOffset.UtcNow);

        return _notifier.NotifyMessageReceivedAsync(message);
    }

    // Subscriptions die with the broker connection; realigns the local list with reality
    private Task OnDisconnectedAsync(MqttClientDisconnectedEventArgs e)
    {
        _filters.Clear();
        return Task.CompletedTask;
    }
}
