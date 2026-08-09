using System.Collections.Concurrent;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;
using MQTTnet;
using MQTTnet.Exceptions;
using MQTTnet.Protocol;

namespace MqttForge.Infrastructure.Mqtt;

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

    // One SUBSCRIBE carries the lot. The round trip costs the same whether it holds one filter
    // or a hundred, and it is the round trip that makes subscribing in bulk slow.
    public async Task SubscribeAsync(IReadOnlyList<SubscriptionRequest> requests, CancellationToken ct)
    {
        EnsureConnected();

        if (requests.Count == 0) return;

        var options = new MqttClientSubscribeOptionsBuilder();
        foreach (var request in requests)
        {
            options.WithTopicFilter(new MqttTopicFilterBuilder()
                .WithTopic(request.TopicFilter)
                .WithQualityOfServiceLevel((MqttQualityOfServiceLevel)request.Qos)
                .Build());
        }

        try
        {
            await _client.SubscribeAsync(options.Build(), ct);
        }
        catch (MqttProtocolViolationException ex)
        {
            var named = string.Join("', '", requests.Select(r => r.TopicFilter));
            throw new MessageRejectedException($"Could not subscribe to '{named}': {ex.Message}", ex);
        }

        foreach (var request in requests) _filters[request.TopicFilter] = 0;
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

    // Subscriptions die with the connection; clears local list to match
    private Task OnDisconnectedAsync(MqttClientDisconnectedEventArgs e)
    {
        _filters.Clear();
        return Task.CompletedTask;
    }
}
