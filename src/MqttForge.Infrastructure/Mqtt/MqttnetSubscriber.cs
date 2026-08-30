using System.Collections.Concurrent;
using MqttForge.Domain;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;
using MQTTnet;
using MQTTnet.Exceptions;
using MQTTnet.Formatter;
using MQTTnet.Protocol;

namespace MqttForge.Infrastructure.Mqtt;

public sealed class MqttnetSubscriber : IMqttSubscriber
{
    /// <summary>
    /// How long after a SUBACK a retained message is read as the broker catching us up rather
    /// than as something that has just happened.
    /// </summary>
    // Two seconds, and it lives here rather than in AlertEngineOptions — which is where it was
    // first written, unused, and where it is deleted by the same task that adds this line. The
    // engine never sees a replay: by the time a message reaches it the flag is already set, and
    // it is set on this side because this is the only side that knows when the SUBACK arrived.
    // A number kept in the engine's ceilings and read by the subscriber would be one setting
    // with two homes, and the day somebody moved the ceiling nothing would change.
    //
    // The size of it is a judgement about brokers, not about the engine: a retained backlog
    // arrives immediately after the SUBACK and in one burst, so this only has to cover a slow
    // link and a broker with a lot to say. Longer would start swallowing live traffic on a
    // freshly subscribed topic, which is the one failure this must not have.
    public static readonly TimeSpan ReplayWindow = TimeSpan.FromSeconds(2);

    private readonly IMqttClient _client;
    private readonly IMessageNotifier _notifier;
    private readonly TimeProvider _time;

    // Filter → who holds it and when the broker granted it. Was a ConcurrentDictionary<string,
    // byte>, which could answer "is this filter up" and nothing else; both of the questions this
    // class now has to answer — "is anybody else still holding it" and "was this message a
    // replay" — are about the value rather than the key.
    private readonly ConcurrentDictionary<string, ActiveFilter> _filters = new(StringComparer.Ordinal);

    public MqttnetSubscriber(
        MqttnetClientProvider provider, IMessageNotifier notifier, TimeProvider? timeProvider = null)
    {
        _client = provider.Client;
        _notifier = notifier;

        // Taken the way MqttnetConnectionManager takes it — last, optional, defaulted to the
        // system clock — so every existing construction of this class goes on compiling and the
        // container goes on resolving it with no registration for TimeProvider anywhere.
        _time = timeProvider ?? TimeProvider.System;

        _client.ApplicationMessageReceivedAsync += OnMessageReceivedAsync;
        _client.DisconnectedAsync += OnDisconnectedAsync;
    }

    public IReadOnlyCollection<string> ActiveFilters => _filters.Keys.ToArray();

    public IReadOnlyCollection<ActiveFilter> Filters => _filters.Values.ToArray();

    // One SUBSCRIBE carries the lot. The round trip costs the same whether it holds one filter
    // or a hundred, and it is the round trip that makes subscribing in bulk slow.
    public async Task SubscribeAsync(IReadOnlyList<SubscriptionRequest> requests, CancellationToken ct,
                                     SubscriptionOwner owner = SubscriptionOwner.Console)
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

        // Read once, after the SUBACK and before anything is recorded, so every filter in one
        // batch carries the same grant moment. Reading the clock per filter would give a
        // hundred-filter batch a hundred slightly different windows for one round trip.
        var granted = _time.GetUtcNow();

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
            if (Granted(item.ResultCode)) Record(item.TopicFilter.Topic, owner, granted);
            else refused.Add($"'{item.TopicFilter.Topic}' ({item.ResultCode})");
        }

        if (refused.Count > 0)
            throw new MessageRejectedException($"The broker refused {string.Join(", ", refused)}.");
    }

    /// <summary>Adds one owner's claim to a filter, and moves its replay window to this SUBACK.</summary>
    // GrantedAt is refreshed even for a filter that was already up, and that is the point rather
    // than an accident: the broker replays the retained tree for every SUBSCRIBE it accepts, not
    // only for the first. The engine subscribing 'plant/#' that the console already holds gets
    // the same backlog the console got, and a window left at the console's grant moment would let
    // all of it through as live traffic.
    private void Record(string filter, SubscriptionOwner owner, DateTimeOffset granted) =>
        _filters.AddOrUpdate(
            filter,
            _ => new ActiveFilter(filter, owner, granted),
            (_, held) => held with { Owners = held.Owners | owner, GrantedAt = granted });

    // The three codes that are a granted QoS rather than a refusal; everything else in the enum is
    // the broker saying no, and MQTT 5 leaves room for reason codes this build has never heard of.
    private static bool Granted(MqttClientSubscribeResultCode code) =>
        code is MqttClientSubscribeResultCode.GrantedQoS0
            or MqttClientSubscribeResultCode.GrantedQoS1
            or MqttClientSubscribeResultCode.GrantedQoS2;

    /// <summary>
    /// Gives up one owner's claim. The broker hears about it only when the last owner lets go.
    /// </summary>
    // The loop is a compare-and-swap and not decoration. Two owners means two callers — a reader
    // clearing a filter chip and the engine reconciling a saved rule set — and a plain
    // read-modify-write on a shared entry would let one of them drop the other's claim.
    // TryUpdate compares by value, which a record gives for nothing.
    public async Task UnsubscribeAsync(string topicFilter, CancellationToken ct,
                                       SubscriptionOwner owner = SubscriptionOwner.Console)
    {
        EnsureConnected();

        while (_filters.TryGetValue(topicFilter, out var held))
        {
            // An owner releasing something it never took is not an error and not a broker call.
            // The engine reconciles by asking for what the rules now need and letting go of what
            // they no longer do, and 'no longer do' includes filters only the console ever had.
            if ((held.Owners & owner) == 0) return;

            var remaining = held.Owners & ~owner;

            if (remaining != SubscriptionOwner.None)
            {
                // Somebody else is still watching this. Nothing goes to the broker, because an
                // UNSUBSCRIBE here would silently take away traffic the other owner is reading.
                if (_filters.TryUpdate(topicFilter, held with { Owners = remaining }, held)) return;
                continue;
            }

            // The last claim. The broker is told first: if the UNSUBSCRIBE throws, the filter is
            // still up and the record has to go on saying so.
            await _client.UnsubscribeAsync(topicFilter, ct);
            _filters.TryRemove(new KeyValuePair<string, ActiveFilter>(topicFilter, held));
            return;
        }
    }

    private void EnsureConnected()
    {
        if (!_client.IsConnected)
            throw new NotConnectedException("Connect to a broker before subscribing.");
    }

    private Task OnMessageReceivedAsync(MqttApplicationMessageReceivedEventArgs e)
    {
        var (payload, encoding) = PayloadText.Describe(e.ApplicationMessage.Payload);
        var now = _time.GetUtcNow();

        var message = new MqttMessage(
            e.ApplicationMessage.Topic,
            payload,
            encoding,
            (int)e.ApplicationMessage.QualityOfServiceLevel,
            e.ApplicationMessage.Retain,
            now,
            Replay: e.ApplicationMessage.Retain && JustSubscribed(e.ApplicationMessage.Topic, now));

        return _notifier.NotifyMessageReceivedAsync(message);
    }

    /// <summary>Whether a filter covering this topic was granted inside the replay window.</summary>
    // The retain flag alone cannot answer this, and that is the whole reason the grant times are
    // kept. SubscribeAsync asks for WithRetainAsPublished on MQTT 5, so a device that publishes
    // its readings retained — which is most of a plant — sends live messages with Retain set. A
    // subscriber that read the flag would mark that entire plant as replay on MQTT 5 and get it
    // right on 3.1.1, and one piece of code cannot mean two opposite things in two protocols.
    //
    // Matched against the filters rather than against a single 'when did we last subscribe to
    // anything', because a subscription replays its own tree and nobody else's: a rule going up
    // on 'plant/#' must not make a live message on 'lab/oven' read as a replay. The walk is over
    // the filters that are up — a handful, not a topic tree — and only ever for a retained
    // message, so ordinary traffic pays one boolean.
    //
    // The boundary is inclusive, as every other deadline in this product is: a message exactly
    // two seconds after the SUBACK is still the broker catching up.
    private bool JustSubscribed(string topic, DateTimeOffset now)
    {
        foreach (var filter in _filters.Values)
        {
            if (now - filter.GrantedAt > ReplayWindow) continue;
            if (TopicFilterMatch.Matches(filter.Filter, topic)) return true;
        }

        return false;
    }

    // Subscriptions die with the connection; clears local list to match
    private Task OnDisconnectedAsync(MqttClientDisconnectedEventArgs e)
    {
        _filters.Clear();
        return Task.CompletedTask;
    }
}
