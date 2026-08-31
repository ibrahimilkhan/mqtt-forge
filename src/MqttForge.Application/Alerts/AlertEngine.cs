using System.Threading.Channels;
using Microsoft.Extensions.Logging;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Alerts;

/// <summary>
/// The transport around <see cref="AlertEngineCore"/>: one bounded queue, one loop that is both
/// the pump and the tick, one published snapshot, and the rule set's own subscriptions.
/// </summary>
// It holds no alerting state whatsoever. Every field here is about carrying things — a queue, a
// clock, the last snapshot, whether the link was up last time it looked — and the moment one of
// them becomes a fact about an alarm it belongs in the core instead, where the lifecycle tests
// can reach it without starting a thread.
//
// The division earns two separate things. The core is pure, so its tests are sequences of
// arguments with no clock and no race in them; this class is the only place a thread exists, so
// its tests are about exactly that and nothing else.
public sealed class AlertEngine
{

    // The dispatcher goes last and is optional, after the clock, and that order is not cosmetic:
    // five call sites construct this class positionally, three of them passing a clock as the
    // eighth argument, and a parameter inserted anywhere before that would rebind their clock to a
    // dispatcher. Null is also the honest default — a host with no webhook and no publish action
    // anywhere has nothing for one to do.
    public AlertEngine(AlertEngineCore core, IAlertRuleStore rules, IAlertStateStore state,
                       IAlertNotifier notifier, IMqttConnectionManager connection,
                       IMqttSubscriber subscriber, ILogger<AlertEngine> log,
                       TimeProvider? timeProvider = null, IAlertDispatcher? dispatcher = null)
    {
        _core = core;
        _rules = rules;
        _state = state;
        _notifier = notifier;
        _connection = connection;
        _subscriber = subscriber;
        _log = log;
        _dispatcher = dispatcher;

        // MqttnetConnectionManager's signature exactly, for the same reason: production wires
        // nothing and the tests hand in a clock they can move.
        _time = timeProvider ?? TimeProvider.System;

        _queue = Channel.CreateBounded<AlertCommand>(
            new BoundedChannelOptions(QueueCapacity)
            {
                FullMode = BoundedChannelFullMode.DropOldest,
                SingleReader = true,
            },
            OnDropped);

        // Published before anything can ask for it. GET /api/alerts can arrive before the host has
        // started the pump, and an empty panel is a better answer than a null reference.
        _snapshot = _core.Snapshot();

        _nextTick = _time.GetUtcNow() + TickInterval;
    }

    /// <summary>
    /// Deep enough to ride out a burst the rules are still working through. Past this the oldest
    /// go, and the count is carried out to the panel rather than lost.
    /// </summary>
    // The same figure and the same bargain as SignalRMessageNotifier's queue. DropOldest is
    // genuinely uncomfortable here — the message that goes over the front may be the one that
    // would have rung — but the alternative is blocking MQTTnet's receive loop, which ties the
    // broker connection itself to the speed of the slowest rule. Accepted, and counted.
    public const int QueueCapacity = 32_768;

    /// <summary>How often the engine looks at the world with no message to prompt it.</summary>
    // One second, because that is the resolution the spec gives every time-based promise: at most
    // one state change per pair per second, silence measured in seconds, mutes and cooldowns
    // expiring on a tick.
    public static readonly TimeSpan TickInterval = TimeSpan.FromSeconds(1);

    // The spec's ceiling on how often alert-state.json may be rewritten. The tick's own cadence
    // would nearly do it, but a stream of commands can turn several times a second between ticks
    // and each of those turns can change an alarm.
    private static readonly TimeSpan SaveInterval = TimeSpan.FromSeconds(1);

    /// <summary>How many commands one turn will take before it looks at the clock again.</summary>
    // Without a bound, a firehose keeps TryRead succeeding for ever and the tick — which is where
    // every alarm resolves and every silence rule rings — never runs. A deep queue drained in
    // batches of a few thousand is a few milliseconds a turn.
    private const int MaxPerTurn = 4_096;

    /// <summary>The QoS the engine asks for on its own subscriptions.</summary>
    // One, deliberately. QoS 0 lets the broker drop the very message a rule was written to catch
    // and say nothing, which is the failure this whole feature exists to prevent. QoS 2 doubles
    // the round trips to guarantee something alerting does not need: a duplicate arrival bumps an
    // existing alert's Count rather than raising a second one, because an alert belongs to a pair.
    private const int RuleQos = 1;

    private readonly AlertEngineCore _core;
    private readonly IAlertRuleStore _rules;
    private readonly IAlertStateStore _state;
    private readonly IAlertNotifier _notifier;

    /// Where an alert goes when it has to leave the process. Null in every test that predates it
    /// and in any host that has wired no outgoing channel at all.
    private readonly IAlertDispatcher? _dispatcher;
    private readonly IMqttConnectionManager _connection;
    private readonly IMqttSubscriber _subscriber;
    private readonly ILogger<AlertEngine> _log;
    private readonly TimeProvider _time;
    private readonly Channel<AlertCommand> _queue;

    private int _dropped;

    /// The last drop total handed to the notifier, so an engine that is keeping up says nothing.
    private int _announced;

    private AlertSnapshot _snapshot;

    /// The rule set the engine is running, kept only to work out which filters it should hold.
    private IReadOnlyList<AlertRule> _live = [];

    /// Whether the link was up the last time the tick looked. Only the transition matters.
    private bool _linkWasUp;

    /// Set when the filters the rules want may differ from the filters the subscriber holds.
    private bool _resubscribe;

    /// Set when something the state file cares about changed and has not been written yet.
    private bool _unsaved;

    private DateTimeOffset _lastSaved;
    private DateTimeOffset _nextTick;

    /// <summary>Commands the queue had to discard because the engine could not keep up.</summary>
    public int Dropped => Volatile.Read(ref _dropped);

    /// <summary>What the panel shows. A read of one reference; never a lock, never the core.</summary>
    public AlertSnapshot Snapshot => Volatile.Read(ref _snapshot);

    /// <summary>Hands a command to the pump. Never blocks and never throws.</summary>
    // Kestrel threads, the MQTT receive loop and the tests all come through here, and none of
    // them may wait on the engine. TryWrite on a DropOldest channel always succeeds: it makes
    // room by discarding the front, which is what OnDropped is counting.
    public void Post(AlertCommand command) => _queue.Writer.TryWrite(command);

    /// <summary>The fan-out's entry point: queue it and get out of the receive loop's way.</summary>
    public Task NotifyMessageReceivedAsync(MqttMessage message)
    {
        Post(new ArrivalCommand(message));

        return Task.CompletedTask;
    }

    private void OnDropped(AlertCommand command)
    {
        Interlocked.Increment(ref _dropped);

        // An arrival going over the front is the bargain the queue struck and is reported as a
        // number. A rule set, a mute or a history clear going over it is not — those are the
        // user's own actions, they arrive a handful at a time, and one lost silently would look
        // like the panel simply not working. It cannot be helped here, but it can be said.
        if (command is not ArrivalCommand)
            _log.LogWarning("The alert engine's queue was full and dropped a {Command}.",
                command.GetType().Name);
    }

    /// <summary>
    /// Reads the two files, hands the core its rules and then its restored state, and puts the
    /// rule set's subscriptions up. Runs once, before the pump.
    /// </summary>
    public async Task StartAsync(CancellationToken ct)
    {
        var document = await LoadRulesAsync(ct);
        var now = _time.GetUtcNow();

        _live = document.Rules;

        // Rules first, always. Restore reconciles what it is given against the rule set the core
        // is holding — an alarm whose rule has gone, or whose ConfigHash moved while the process
        // was down, resolves instead of coming back — and reconciling against an empty set would
        // end every alarm on every restart.
        var outcome = _core.SetRules(_live, now);

        if (await LoadStateAsync(ct) is { } restored)
            outcome = Merge(outcome, _core.Restore(restored, now));

        Publish();
        await DeliverAsync(outcome);

        // Anything the reconciliation ended has to be written down before the next crash, or the
        // hand-over file offers the same dead alarm again on every start.
        _unsaved = outcome.Resolved.Count > 0;

        // The link may well be down at this point — the supervisor connects on its own schedule —
        // in which case this does nothing and the flag stays set for the reconnect to honour.
        _resubscribe = true;
        _linkWasUp = _connection.State == ConnectionState.Connected;
        await SyncSubscriptionsAsync(ct);
    }

    /// <summary>The pump and the tick, in one loop, for the life of the process.</summary>
    public async Task RunAsync(CancellationToken ct)
    {
        var reader = _queue.Reader;

        // Held across iterations rather than made fresh each time round the loop. A wait that
        // loses the race is still a live wait on the same reader, and abandoning one per second
        // would pile up registrations — and, on cancellation, a pile of cancelled tasks nobody
        // ever observes.
        var ready = reader.WaitToReadAsync(ct).AsTask();

        try
        {
            while (!ct.IsCancellationRequested)
            {
                await TurnAsync(ct);

                var wait = _nextTick - _time.GetUtcNow();
                if (wait < TimeSpan.Zero) wait = TimeSpan.Zero;

                // THE shape, and the one thing about this class that is not negotiable.
                //
                // SignalRMessageNotifier is `while (await reader.WaitToReadAsync(ct))` and that is
                // right for it: a console with nothing to send has nothing to do. It cannot be
                // copied here. That loop never wakes on an empty queue, and an empty queue is
                // precisely the state a silence rule exists to notice — a device that has stopped
                // publishing sends nothing at all, so waiting for it to send something is waiting
                // for the one event that will never come. The delay is the other arm of the race,
                // and it is what makes 'nothing happened' an event this engine can act on.
                //
                // The delay carries no cancellation token on purpose: the token is already on the
                // wait, so a cancelled run comes out through `ready` immediately, and a delay
                // abandoned mid-race is one timer that fires into nothing rather than a cancelled
                // task with an exception nobody is left to observe.
                var woken = await Task.WhenAny(ready, Task.Delay(wait, _time));

                if (woken == ready)
                {
                    // False means the writer completed, which nothing does today; it is here so a
                    // closed channel ends the loop rather than spinning on a reader that will
                    // never have anything again.
                    if (!await ready) break;

                    ready = reader.WaitToReadAsync(ct).AsTask();
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Shutdown. Whatever is still queued goes with the process, and the state file already
            // holds everything a restart is not allowed to lose.
        }
    }

    /// <summary>One turn: drain what is queued, tick if a tick is due, then tell everybody.</summary>
    private async Task TurnAsync(CancellationToken ct)
    {
        var raised = new List<Alert>();
        var resolved = new List<Alert>();
        var changed = false;
        var dropped = Dropped;

        try
        {
            var handled = 0;
            while (handled < MaxPerTurn && _queue.Reader.TryRead(out var command))
            {
                handled++;
                changed = true;

                var outcome = Apply(command, _time.GetUtcNow());
                raised.AddRange(outcome.Raised);
                resolved.AddRange(outcome.Resolved);
            }

            // The one number the core cannot work out for itself: the queue in front of it did the
            // dropping, and by the time a message is missing there is nothing in there to notice.
            dropped = Dropped;
            _core.SetDropped(dropped);

            var now = _time.GetUtcNow();
            if (now >= _nextTick)
            {
                // Set before the tick runs, not after. If OnTick were ever to throw, an unmoved
                // _nextTick would make every following iteration due immediately and turn a
                // contained fault into a spin at full speed.
                //
                // And it is set from now rather than advanced by one interval, so a pump that was
                // held up for ten seconds does ONE tick when it gets back rather than ten in a row
                // — a catch-up storm would resolve on the strength of ten ticks nobody watched.
                _nextTick = now + TickInterval;

                // Polled, never pushed. IConnectionStateNotifier exists and would happily tell the
                // engine, but that is a delivery channel with its own queue: a tick that asks the
                // manager gets the truth as of this instant, while a tick that waits to be told
                // could judge a whole second of silence against a link that had already gone.
                var connected = _connection.State == ConnectionState.Connected;

                var outcome = _core.OnTick(now, connected);
                raised.AddRange(outcome.Raised);
                resolved.AddRange(outcome.Resolved);

                // Subscriptions die with the connection — MqttnetSubscriber clears its own set on
                // disconnect — so the link coming back is the third of the three moments the rule
                // set has to be applied.
                if (connected && !_linkWasUp) _resubscribe = true;
                _linkWasUp = connected;

                // A tick is always worth republishing for. Things end on a tick that produce no
                // outcome at all — a mute expiring, a cooldown lapsing — and a snapshot published
                // only when an alarm moved would leave the panel showing "muted until 09:30" at
                // ten o'clock.
                changed = true;
            }

            if (_resubscribe) await SyncSubscriptionsAsync(ct);

            // Before the telling, so a console that reacts to a raised alert by fetching the
            // snapshot finds the alert already in it.
            if (changed) Publish();

            if (raised.Count > 0 || resolved.Count > 0) _unsaved = true;

            await DeliverAsync(new EngineOutcome(raised, resolved));
            await AnnounceDropsAsync(dropped);
            await SaveStateAsync(ct);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            // Nothing escapes the pump. The core contains a faulting rule itself, and every call
            // below has its own catch, so reaching this line means a fault nobody predicted — and
            // the answer to that is still not "take the host down and stop alerting entirely".
            _log.LogError(ex, "A turn of the alert engine failed. The engine is carrying on.");
        }
    }

    private EngineOutcome Apply(AlertCommand command, DateTimeOffset now)
    {
        switch (command)
        {
            case ArrivalCommand arrival:
                return _core.OnMessage(arrival.Message, now);

            case RuleSetChangedCommand change:
                // The engine never re-reads the file on this path. It read it once at startup and
                // everything after that is a push, because the reader here is the message path and
                // not a console: ColourRuleService's "nothing is cached" is right for a panel and
                // would be a file read per save on the hot side of the engine.
                _live = change.Rules;
                _resubscribe = true;

                return _core.SetRules(change.Rules, now);

            case MuteCommand mute:
                return _core.Mute(mute.RuleId, mute.Topic, mute.Minutes, now);

            case ClearHistoryCommand:
                _core.ClearHistory();

                return EngineOutcome.Empty;

            default:
                // A record added to the union without a case here. Logged rather than thrown: the
                // alternative is a pump that dies of a command it did not recognise.
                _log.LogWarning("The alert engine does not know what to do with a {Command}.",
                    command.GetType().Name);

                return EngineOutcome.Empty;
        }
    }

    /// <summary>
    /// Puts the filters the enabled rules want up, and takes down the ones only a departed rule
    /// wanted. Called on startup, on every rule set, and on every reconnect.
    /// </summary>
    // The spec's "Kuralın filtresi bir aboneliktir": without this the engine is deaf. The user
    // writes a rule, no message matching it is ever subscribed, the rule never fires, and nothing
    // anywhere says why — and in Docker there is nobody to open the Filters panel and notice.
    //
    // A diff and not a refresh. Re-sending the whole set every time would make the broker replay
    // every retained value under every filter on each pass, which is an alarm storm on a timer.
    private async Task SyncSubscriptionsAsync(CancellationToken ct)
    {
        // Nothing can be subscribed on a client that is not connected — MqttnetSubscriber throws
        // NotConnectedException — and there is nothing to take down either, because the filters
        // went with the socket. The flag stays set, so the reconnect brings the whole set back.
        if (_connection.State != ConnectionState.Connected) return;

        var wanted = new HashSet<string>(StringComparer.Ordinal);
        foreach (var rule in _live)
            if (rule.Enabled)
                wanted.Add(rule.Filter);

        // Only what this engine owns. A filter the console put up is the console's business, and
        // unsubscribing it because no rule wants it would empty the user's own Filters panel.
        var held = new HashSet<string>(StringComparer.Ordinal);
        foreach (var filter in _subscriber.Filters)
            if (filter.Owners.HasFlag(SubscriptionOwner.Rules))
                held.Add(filter.Filter);

        var missing = new List<SubscriptionRequest>();
        foreach (var filter in wanted)
            if (!held.Contains(filter))
                missing.Add(new SubscriptionRequest(filter, RuleQos));

        var gone = new List<string>();
        foreach (var filter in held)
            if (!wanted.Contains(filter))
                gone.Add(filter);

        try
        {
            // One SUBSCRIBE for the lot: the round trip costs the same whether it carries one
            // filter or a hundred, and it is the round trip that makes subscribing in bulk slow.
            if (missing.Count > 0)
                await _subscriber.SubscribeAsync(missing, ct, SubscriptionOwner.Rules);

            // One at a time, because that is the shape UNSUBSCRIBE has here — and because a
            // filter the console also holds must survive, which is the subscriber's ownership
            // arithmetic and not this loop's business.
            foreach (var filter in gone)
                await _subscriber.UnsubscribeAsync(filter, ct, SubscriptionOwner.Rules);

            _resubscribe = false;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // A broker is entitled to refuse a filter — a wildcard too broad for it, a topic its
            // ACL does not allow — and it may refuse it by closing the connection. None of that
            // may stop the pump, and none of it is permanent: the flag is left set, so the next
            // turn asks again, and the filter goes up the moment the broker will have it.
            _log.LogWarning(ex,
                "The alert engine could not apply its rule subscriptions. It will try again.");
        }
    }

    private void Publish() => Volatile.Write(ref _snapshot, _core.Snapshot());

    private async Task AnnounceDropsAsync(int dropped)
    {
        if (dropped == _announced) return;

        _announced = dropped;

        try
        {
            await _notifier.DroppedAsync(dropped);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.LogError(ex, "An alert notifier threw while being told the drop total.");
        }
    }

    private async Task SaveStateAsync(CancellationToken ct)
    {
        if (!_unsaved) return;

        var now = _time.GetUtcNow();
        if (now - _lastSaved < SaveInterval) return;

        try
        {
            await _state.SaveAsync(_core.Capture(), ct);

            // Cleared only on the way out of a save that worked. A file the container cannot write
            // to would otherwise swallow the change silently; this way the next second tries again.
            _unsaved = false;
            _lastSaved = now;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _lastSaved = now;
            _log.LogWarning(ex, "The alert state could not be written. It will be tried again.");
        }
    }

    private async Task<AlertRuleDocument> LoadRulesAsync(CancellationToken ct)
    {
        try
        {
            var document = await _rules.LoadAsync(ct);

            if (document.Unreadable)
                _log.LogError(
                    "The alert rules file could not be read. The engine is running with no rules " +
                    "at all until the file is repaired or deliberately overwritten.");
            else if (document.SkippedIds.Count > 0)
                _log.LogError(
                    "The alert rules file holds {Count} rule(s) this build cannot read ({Ids}). " +
                    "They are not running.",
                    document.SkippedIds.Count, string.Join(", ", document.SkippedIds));

            return document;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // The store promises never to throw for a file it cannot parse — it says Unreadable
            // instead — so this is the fault it makes no promise about: a directory where the file
            // should be, a permission the container does not have. Starting deaf and saying so
            // beats failing to start, because a host that will not start takes the console with it.
            _log.LogError(ex, "The alert rules could not be loaded. The engine is starting with no rules.");

            return new AlertRuleDocument([], Unreadable: true, []);
        }
    }

    private async Task<AlertState?> LoadStateAsync(CancellationToken ct)
    {
        try
        {
            return await _state.LoadAsync(ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // A hand-over, not a record. Losing it costs one round of resolved bodies and a few
            // mutes; refusing to start over it would cost every alert from now until somebody
            // notices, which is the trade the rules file makes in the opposite direction and for
            // a reason that does not apply here.
            _log.LogError(ex, "The alert state could not be read. The engine is starting with none.");

            return null;
        }
    }

    private static EngineOutcome Merge(EngineOutcome first, EngineOutcome second)
    {
        if (first.Raised.Count == 0 && first.Resolved.Count == 0) return second;
        if (second.Raised.Count == 0 && second.Resolved.Count == 0) return first;

        return new EngineOutcome([.. first.Raised, .. second.Raised],
                                 [.. first.Resolved, .. second.Resolved]);
    }

    private async Task DeliverAsync(EngineOutcome outcome)
    {
        if (outcome.Raised.Count == 0 && outcome.Resolved.Count == 0) return;

        try
        {
            if (outcome.Raised.Count > 0) await _notifier.RaisedAsync(outcome.Raised);
            if (outcome.Resolved.Count > 0) await _notifier.ResolvedAsync(outcome.Resolved);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Telling is downstream of judging. A webhook endpoint that has gone away, or a hub
            // with no clients, must not stop this engine noticing the next thing that goes wrong.
            _log.LogError(ex, "An alert notifier threw. The alerts it was given were not delivered.");
        }

        // After the notifier and in its own try, both deliberately. The console is the fast local
        // channel and a screen notice must not wait behind a POST; and a fault in either of them
        // is a fault in one channel, never in the other and never in the pump.
        await DispatchAsync(outcome);
    }

    /// <summary>Hands on the alerts whose rules asked for something outside this process.</summary>
    private async Task DispatchAsync(EngineOutcome outcome)
    {
        if (_dispatcher is null) return;

        var raised = Outgoing(outcome.Raised);
        var resolved = Outgoing(outcome.Resolved);

        if (raised.Count == 0 && resolved.Count == 0) return;

        try
        {
            if (raised.Count > 0) await _dispatcher.RaisedAsync(raised);
            if (resolved.Count > 0) await _dispatcher.ResolvedAsync(resolved);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // One line for the turn rather than one per alert, and Error rather than Warning: an
            // alert that was meant to leave the machine and did not is the failure this whole
            // feature exists to prevent, and the spec's own measure is that a channel which fails
            // silently is worse than one that does not exist.
            _log.LogError(ex, "An alert dispatcher threw. The alerts it was given were not delivered.");
        }
    }

    /// <summary>The alerts with somewhere outside to go.</summary>
    // The filter lives here rather than in each dispatcher because the answer is the same for all
    // of them and the cost is not: on a plant where every rule draws a screen notice and one rule
    // posts a webhook, this is the difference between waking a queue with a bounded depth and a
    // shared HttpClient on every alarm and waking it on the ones that have a reason to.
    //
    // Allocating nothing when nothing qualifies is the common case and worth the extra line: the
    // shipped product's example rules are screen and sound.
    private static IReadOnlyList<Alert> Outgoing(IReadOnlyList<Alert> alerts)
    {
        List<Alert>? outgoing = null;

        foreach (var alert in alerts)
            foreach (var action in alert.Actions)
                if (action is WebhookAction or PublishAction)
                {
                    (outgoing ??= []).Add(alert);
                    break;
                }

        return outgoing ?? [];
    }
}
