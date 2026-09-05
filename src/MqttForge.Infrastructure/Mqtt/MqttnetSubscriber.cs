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

public sealed class MqttnetSubscriber : IMqttSubscriber, ISubscriptionRestorer
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

    // The QoS each console filter was asked at, so that a filter put back after a drop is put
    // back at the ceiling it had. Kept beside the active list rather than on ActiveFilter, which
    // the engine reads and which has no use for it.
    private readonly ConcurrentDictionary<string, int> _consoleQos = new(StringComparer.Ordinal);

    // What the console held at the moment the link last went. Written on every disconnect and
    // read by RestoreConsoleFiltersAsync, so it is always about the latest link: a filter the
    // reader dropped an hour ago is not in it, and neither is one from a broker they left.
    private volatile IReadOnlyList<SubscriptionRequest> _heldAtDrop = [];

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
        var asked = requests.ToDictionary(r => r.TopicFilter, r => r.Qos, StringComparer.Ordinal);

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
            // Every filter in the packet is named: the broker closed the session rather than
            // answering per filter, so which of them it objected to is not knowable from here.
            throw new MessageRejectedException(
                $"The broker refused '{named}' and closed the connection. " +
                "A filter covering more of the topic tree than the broker allows is the usual cause.",
                [.. requests.Select(r => r.TopicFilter)],
                ex);
        }
        // The same refusal from a broker too old to send a DISCONNECT packet: it closes the TCP
        // socket while the SUBSCRIBE is in flight, and MQTTnet hands that over as a bare
        // communication failure. Azure IoT Hub does exactly this to a filter it does not allow,
        // and reading it as 'the link died' left the filter unnamed and the reader with nothing to
        // narrow. Only while subscribing: everywhere else this shape means what it says.
        catch (MqttCommunicationException ex) when (ex is not MqttClientUnexpectedDisconnectReceivedException)
        {
            throw new MessageRejectedException(
                $"The broker closed the connection while '{named}' was being asked for. " +
                "A filter covering more of the topic tree than the broker allows is the usual cause.",
                [.. requests.Select(r => r.TopicFilter)],
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
        var refusedFilters = new List<string>();
        foreach (var item in result.Items)
        {
            if (Granted(item.ResultCode))
            {
                Record(item.TopicFilter.Topic, owner, granted);

                // The QoS asked for, off the request rather than off the answer: the answer's
                // code is the grant, which a broker may set lower, and a restore should ask for
                // what the reader asked for rather than for what the last broker allowed.
                if (owner.HasFlag(SubscriptionOwner.Console))
                    _consoleQos[item.TopicFilter.Topic] = asked.GetValueOrDefault(item.TopicFilter.Topic);
            }
            else
            {
                refused.Add($"'{item.TopicFilter.Topic}' ({item.ResultCode})");
                refusedFilters.Add(item.TopicFilter.Topic);
            }
        }

        if (refused.Count > 0)
            throw new MessageRejectedException(
                $"The broker refused {string.Join(", ", refused)}.", refusedFilters);
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
    /// <inheritdoc />
    // Only the console's. The engine's filters come back through the engine, which watches the
    // link for exactly this and re-syncs its own; asking for them here as well would double every
    // SUBSCRIBE on a redial and put the engine's replay window in the wrong place.
    public async Task RestoreConsoleFiltersAsync(CancellationToken ct)
    {
        var held = _heldAtDrop;
        if (held.Count == 0) return;

        // Taken before the ask rather than after it: a drop in the middle of the restore writes
        // a fresh stash, and this one must not overwrite it on the way out.
        _heldAtDrop = [];

        await SubscribeAsync(held, ct, SubscriptionOwner.Console);
    }

    private Task OnDisconnectedAsync(MqttClientDisconnectedEventArgs e)
    {
        // Only a link that was actually up has filters worth keeping, and that is the whole of
        // why this is gated. MQTTnet raises this event on the failed-connect path too, with
        // nothing subscribed — so an outage that took more than one rung used to overwrite the
        // stash with an empty list on the first failed try, and the rung that finally worked
        // restored nothing. The reader was left on a green link listening to none of the topics
        // they had asked for. ClientWasConnected is the same flag MqttnetConnectionManager reads
        // to tell a drop from a dial that never landed.
        if (!e.ClientWasConnected) return Task.CompletedTask;

        // What the console had, kept for the redial — see RestoreConsoleFiltersAsync. Written
        // whether or not this drop was the reader's own Disconnect: a restore only ever follows
        // the supervisor's redial, and the supervisor never redials a link somebody hung up on.
        _heldAtDrop = [.. _filters.Values
            .Where(filter => filter.Owners.HasFlag(SubscriptionOwner.Console))
            .Select(filter => new SubscriptionRequest(filter.Filter, _consoleQos.GetValueOrDefault(filter.Filter)))];

        _filters.Clear();
        _consoleQos.Clear();
        return Task.CompletedTask;
    }
}
