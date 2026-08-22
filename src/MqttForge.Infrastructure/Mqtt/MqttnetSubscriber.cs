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

        var named = string.Join("', '", requests.Select(r => r.TopicFilter));

        try
        {
            await _client.SubscribeAsync(options.Build(), ct);
        }
        catch (MqttProtocolViolationException ex)
        {
            throw new MessageRejectedException($"Could not subscribe to '{named}': {ex.Message}", ex);
        }
        // A broker is allowed to refuse a filter by ending the session rather than by answering
        // the SUBSCRIBE, and public ones do: mqtt.hsl.fi closes on any wildcard it considers too
        // broad, measured. MQTTnet raises that as an unexpected DISCONNECT, which is neither a
        // protocol violation nor anything the catch above knew about — so it travelled out
        // unhandled and the reader got a bare 500 naming neither the filter nor the objection.
        catch (MqttClientUnexpectedDisconnectReceivedException ex)
        {
            throw new MessageRejectedException(
                $"The broker refused '{named}' and closed the connection. " +
                "A filter covering more of the topic tree than the broker allows is the usual cause.",
                ex);
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
        var (payload, encoding) = PayloadText.Describe(e.ApplicationMessage.Payload);

        var message = new MqttMessage(
            e.ApplicationMessage.Topic,
            payload,
            encoding,
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
