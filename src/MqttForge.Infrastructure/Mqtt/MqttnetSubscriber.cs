using System.Collections.Concurrent;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;
using MQTTnet;
using MQTTnet.Exceptions;
using MQTTnet.Formatter;
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

        // Retain as published, where the link can carry it.
        //
        // Without it a broker clears the retain bit on every copy it forwards to a subscription
        // that was already up, and sets it only on the copy it replays because a subscription has
        // just been made. That is the protocol working as written, and it made this console
        // unable to answer a fair question about itself: a reader publishing with Retain ticked
        // got their own message back stamped 'not retained' and concluded the flag had been
        // dropped. With this on, the flag on the copy is the flag the publisher set.
        //
        // MQTT 5 only — it is a subscription option that does not exist in 3.1.1, and MQTTnet
        // validates its features before it sends, so asking for it on an older link would turn
        // every subscribe into a protocol violation. The client's own options carry the version
        // that was accepted, which on `auto` is whatever the ladder settled on.
        var asPublished = _client.Options?.ProtocolVersion == MqttProtocolVersion.V500;

        var options = new MqttClientSubscribeOptionsBuilder();
        foreach (var request in requests)
        {
            var filter = new MqttTopicFilterBuilder()
                .WithTopic(request.TopicFilter)
                .WithQualityOfServiceLevel((MqttQualityOfServiceLevel)request.Qos);

            if (asPublished) filter.WithRetainAsPublished(true);

            options.WithTopicFilter(filter.Build());
        }

        var named = string.Join("', '", requests.Select(r => r.TopicFilter));

        MqttClientSubscribeResult result;

        try
        {
            result = await _client.SubscribeAsync(options.Build(), ct);
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

        // The ordinary way a broker refuses a filter, and the quiet one: a SUBACK carries a reason
        // code per filter, and a refusal is a code rather than an exception. The result used to be
        // discarded and every filter recorded regardless, so a filter the broker had just turned
        // down went into the active list and the console listed a subscription it did not have —
        // the same fault the disconnect above was fixed for, arriving by the plain route rather
        // than the dramatic one.
        //
        // Whatever WAS granted is genuinely up, so it is recorded whatever happened to the rest: a
        // batch is one packet but not one decision, and forgetting the granted half would leave
        // the console wrong in the other direction.
        var refused = new List<string>();
        foreach (var item in result.Items)
        {
            if (Granted(item.ResultCode)) _filters[item.TopicFilter.Topic] = 0;
            else refused.Add($"'{item.TopicFilter.Topic}' ({item.ResultCode})");
        }

        if (refused.Count > 0)
            throw new MessageRejectedException($"The broker refused {string.Join(", ", refused)}.");
    }

    // The three codes that are a granted QoS rather than a refusal; everything else in the enum is
    // the broker saying no, and MQTT 5 leaves room for reason codes this build has never heard of.
    private static bool Granted(MqttClientSubscribeResultCode code) =>
        code is MqttClientSubscribeResultCode.GrantedQoS0
            or MqttClientSubscribeResultCode.GrantedQoS1
            or MqttClientSubscribeResultCode.GrantedQoS2;

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
