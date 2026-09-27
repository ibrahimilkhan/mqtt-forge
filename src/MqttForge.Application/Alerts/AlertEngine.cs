using System.Threading.Channels;
using Microsoft.Extensions.Logging;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Alerts;

/// <summary>
/// The transport around <see cref="AlertEngineCore"/>: one bounded queue, one loop that is both
/// the pump and the tick, a second that tells the console, one published snapshot, and the rule
/// set's own subscriptions.
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
    // anywhere has nothing for one to do. The console comes after it, for the same two reasons.
    public AlertEngine(AlertEngineCore core, IAlertRuleStore rules, IAlertStateStore state,
                       IAlertNotifier notifier, IMqttConnectionManager connection,
                       IMqttSubscriber subscriber, ILogger<AlertEngine> log,
                       TimeProvider? timeProvider = null, IAlertDispatcher? dispatcher = null,
                       IAlertConsole? console = null)
    {
        _core = core;
        _rules = rules;
        _state = state;
        _notifier = notifier;
        _connection = connection;
        _subscriber = subscriber;
        _log = log;
        _dispatcher = dispatcher;
        _console = console is null ? null : new AlertConsoleSender(console, log);

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

    /// <summary>How long the rules' filters are left, once the broker did not answer for them, before they are asked for again.</summary>
    // Every attempt at a broker that keeps the link and does not answer holds the pump for the
    // subscriber's whole deadline, and the turn after one used to ask again at once: the pump then
    // made one turn per deadline, every rule a reading behind for as long as the broker kept that
    // up. A pause between the attempts gives the pump turns of its own. Short, because a broker that
    // was only slow answers the next time, and a new link asks at once whatever the pause.
    public static readonly TimeSpan NoAnswerPause = TimeSpan.FromSeconds(5);

    private readonly AlertEngineCore _core;
    private readonly IAlertRuleStore _rules;
    private readonly IAlertStateStore _state;
    private readonly IAlertNotifier _notifier;

    /// Where an alert goes when it has to leave the process. Null in every test that predates it
    /// and in any host that has wired no outgoing channel at all.
    private readonly IAlertDispatcher? _dispatcher;

    /// The console's half of every alert, sent from a loop of its own. Null in every test that
    /// predates it and in any host with no console to tell.
    private readonly AlertConsoleSender? _console;
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

    /// <summary>Filters this broker has already refused, on this link.</summary>
    // The engine used to leave the resubscribe flag up after a refusal, so the same filter was
    // asked for again on the next turn — once a second, for as long as the link lasted. A broker
    // that said no says no again: it is a wasted round trip a second, and some brokers count that
    // as abuse. So a refused filter is set aside and not asked for again.
    //
    // Not for ever: the set is emptied whenever the question is genuinely new — a link made again
    // (a broker restarted with a different ACL is the ordinary case) or moved to another broker,
    // and a rule set the reader has just edited. Each of them forces a resubscribe, so each clears
    // this in the same breath.
    private readonly HashSet<string> _refused = new(StringComparer.Ordinal);

    /// <summary>Until when the rules' filters are not asked for, after a broker that did not answer for them. See NoAnswerPause.</summary>
    private DateTimeOffset _askAgainAt = DateTimeOffset.MinValue;

    /// <summary>Which broker the pairs in the core were learned from.</summary>
    // See AlertEngineCore.ForgetTopics. A link to a different broker is a different world, and
    // the per-topic state of the old one has nothing true to say about it.
    private string? _learnedFrom;

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
        var events = new List<AlertEvent>(AlertEvent.Of(_core.SetRules(_live, now)));

        if (await LoadStateAsync(ct) is { } restored)
            events.AddRange(AlertEvent.Of(_core.Restore(restored, now)));

        Publish();
        await DeliverAsync(events, ct);

        // Anything the reconciliation ended has to be written down before the next crash, or the
        // hand-over file offers the same dead alarm again on every start.
        _unsaved = events.Count > 0;

        // The link may well be down at this point — the supervisor connects on its own schedule —
        // in which case this does nothing and the flag stays set for the reconnect to honour.
        _resubscribe = true;
        _refused.Clear();
        _linkWasUp = _connection.State == ConnectionState.Connected;
        await SyncSubscriptionsAsync(ct);
    }

    /// <summary>The pump and the tick, in one loop, for the life of the process.</summary>
    public async Task RunAsync(CancellationToken ct)
    {
        // The console's loop, started and stopped with the pump: what the pump tells the console is
        // sent from there, so no console, however slow, is ever something the pump waits for.
        var telling = _console?.RunAsync(ct) ?? Task.CompletedTask;
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
        finally
        {
            // Ends on the same token, which calls off a send a console was sitting on.
            _console?.Complete();
            await telling;
        }
    }

    /// <summary>One turn: drain what is queued, tick if a tick is due, then tell everybody.</summary>
    private async Task TurnAsync(CancellationToken ct)
    {
        // In the order they happened, call after call. See AlertEvent.
        var events = new List<AlertEvent>();
        var changed = false;
        var dropped = Dropped;

        try
        {
            var handled = 0;
            while (handled < MaxPerTurn && _queue.Reader.TryRead(out var command))
            {
                handled++;
                changed = true;

                events.AddRange(AlertEvent.Of(Apply(command, _time.GetUtcNow())));
            }

            // The one number the core cannot work out for itself: the queue in front of it did the
            // dropping, and by the time a message is missing there is nothing in there to notice.
            dropped = Dropped;
            _core.SetDropped(dropped);

            var now = _time.GetUtcNow();
            var tick = now >= _nextTick;
            var connected = false;

            if (tick)
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
                connected = _connection.State == ConnectionState.Connected;

                // And if it IS a different broker, everything the rules learned at the last one
                // goes — before the tick judges anything, so no silence rule fires about a topic
                // that belongs to a broker nobody is connected to. Read on every tick rather than
                // only on the transition below: the reader can move the link from one live broker
                // to another without it ever being seen down.
                if (connected)
                {
                    var link = _connection.Link;
                    var endpoint = link is null ? null : $"{link.Host}:{link.Port}";

                    if (endpoint is not null && _learnedFrom is not null && endpoint != _learnedFrom)
                    {
                        _core.ForgetTopics();
                        _log.LogInformation(
                            "The link moved from {Was} to {Now}, so the rules start again: what they had learned was the other broker's.",
                            _learnedFrom, endpoint);

                        // A move no tick saw down is a new link all the same: the rules' filters
                        // went with the old one, and a refusal was the other broker's answer.
                        NewLink();
                    }

                    if (endpoint is not null) _learnedFrom = endpoint;
                }

                events.AddRange(AlertEvent.Of(_core.OnTick(now, connected)));

                if (connected && !_linkWasUp) NewLink();

                _linkWasUp = connected;

                // A tick is always worth republishing for. Things end on a tick that produce no
                // outcome at all — a mute expiring, a cooldown lapsing — and a snapshot published
                // only when an alarm moved would leave the panel showing "muted until 09:30" at
                // ten o'clock.
                changed = true;
            }

            // Before the telling, so a console that reacts to a raised alert by fetching the
            // snapshot finds the alert already in it.
            if (changed) Publish();

            if (events.Count > 0) _unsaved = true;

            // What the turn decided goes out, and is written down, before the filters are looked
            // at. That look reads the subscriber and may wait on a SUBSCRIBE, so ahead of this a
            // broker slow to answer held every alarm of the turn back with it, and anything it
            // threw took them to the catch below: raised in the core and told to nobody.
            await DeliverAsync(events, ct);
            await AnnounceDropsAsync(dropped, ct);
            await SaveStateAsync(ct);

            // And filters that went with no transition to show for it: a link that dropped and came
            // back between two ticks, a move to a broker the manager had not named yet. Once a tick,
            // what the rules want is held against what the subscriber holds for them — in memory,
            // so the look costs nothing and asks the broker nothing.
            if (tick && connected && !_resubscribe && FiltersMissing()) _resubscribe = true;

            if (_resubscribe && !Pausing(now)) await SyncSubscriptionsAsync(ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            // Nothing escapes the pump. The core contains a faulting rule itself, and every call
            // below has its own catch, so reaching this line means a fault nobody predicted — and
            // the answer to that is still not "take the host down and stop alerting entirely".
            //
            // That includes a cancellation nobody here asked for. RunAsync reads any cancellation
            // that reaches it as shutdown, so one from anywhere else — MQTTnet failing a SUBSCRIBE
            // as it tears its own link down — ended the pump for good, with the process still up,
            // no rule judged again, and not a line in the log to say so.
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

                // The reader has just edited the rules, which is the other way a refused filter
                // becomes worth asking about again — most obviously by being narrowed.
                _refused.Clear();

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

    /// <summary>What a new link, or a link to another broker, asks of the rules' subscriptions.</summary>
    // Subscriptions die with the connection — MqttnetSubscriber clears its own set on disconnect and
    // puts back only the console's — so a new link is the third of the three moments the rule set
    // has to be applied. And it is a new answer: the broker may have been restarted with a different
    // ACL, or be a different broker altogether, so what was refused is asked for again, and a rule
    // set aside over a refusal is let back in to be refused again or not.
    private void NewLink()
    {
        _resubscribe = true;
        _refused.Clear();
        _core.ForgetRefusals();
        _askAgainAt = DateTimeOffset.MinValue;
    }

    /// <summary>Whether the broker did not answer for the filters so lately that asking again now would only wait on it again.</summary>
    // A pause that ends further off than a whole pause is a clock set back since, and is over.
    private bool Pausing(DateTimeOffset now) => now < _askAgainAt && _askAgainAt - now <= NoAnswerPause;

    /// <summary>Whether a filter an enabled rule wants, and the broker has not refused, is not held for the rules.</summary>
    private bool FiltersMissing()
    {
        var held = HeldForRules();

        foreach (var rule in _live)
            if (rule.Enabled && !held.Contains(rule.Filter) && !_refused.Contains(rule.Filter))
                return true;

        return false;
    }

    /// <summary>The filters the subscriber holds on the rules' behalf, whoever else holds them too.</summary>
    // Only what this engine owns. A filter the console put up is the console's business, and
    // unsubscribing it because no rule wants it would empty the user's own Filters panel.
    private HashSet<string> HeldForRules()
    {
        var held = new HashSet<string>(StringComparer.Ordinal);

        foreach (var filter in _subscriber.Filters)
            if (filter.Owners.HasFlag(SubscriptionOwner.Rules))
                held.Add(filter.Filter);

        return held;
    }

    /// <summary>
    /// Puts the filters the enabled rules want up, and takes down the ones only a departed rule
    /// wanted. Called on startup, on every rule set, on every new link, and on a tick that finds a
    /// filter missing.
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

        var held = HeldForRules();

        var missing = new List<SubscriptionRequest>();
        foreach (var filter in wanted)
            if (!held.Contains(filter) && !_refused.Contains(filter))
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
        catch (MessageRejectedException refusal)
        {
            // The broker said no to these, so they are not asked for again on this link: it would
            // say no again, once a second, for as long as the link lasted. Whatever else was in
            // the packet is still wanted, so the flag stays up and the next turn asks for the
            // rest — which is also how a session the broker closed over one filter comes back
            // with the others.
            // What the broker named, or — when it named nothing, which is what an older broker
            // closing the session amounts to — everything this packet asked for. Either way the
            // engine must come away knowing not to ask again, or the retry it was left with is
            // the once-a-second loop this is here to end.
            var refused = refusal.Filters.Count > 0
                ? refusal.Filters
                : [.. missing.Select(request => request.TopicFilter)];

            foreach (var filter in refused) _refused.Add(filter);

            var marked = false;
            foreach (var rule in _live)
            {
                if (!rule.Enabled || !_refused.Contains(rule.Filter)) continue;

                _core.MarkFilterRefused(rule.Id, rule.Filter);
                marked = true;
            }

            // The panel is told at once rather than on the next thing that happens to change: a
            // rule that will never be sent anything produces no arrivals and no ticks worth
            // publishing for, so waiting for one would leave the reason unread for as long as the
            // link lasted.
            if (marked) Publish();

            _log.LogWarning(refusal,
                "The broker refused {Count} rule filter(s); they will not be asked for again on this link.",
                refusal.Filters.Count);
        }
        catch (BrokerDidNotAnswerException silence)
        {
            // Not a refusal, and not for the very next turn either: see NoAnswerPause. The flag
            // stays up, so the first turn after the pause asks again.
            _askAgainAt = _time.GetUtcNow() + NoAnswerPause;

            _log.LogWarning(silence,
                "The broker did not answer for the rule subscriptions. They will be asked for again in {Seconds} seconds.",
                NoAnswerPause.TotalSeconds);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            // Everything else — a link that went in the middle of the packet, a fault nobody
            // foresaw. None of it may stop the pump, and none of it is permanent: the flag is
            // left set, so the next turn asks again.
            //
            // A cancellation is one of these unless it is this pump's own. MQTTnet 5 can fail a
            // SUBSCRIBE that was waiting when its keep-alive gave up on the link with the
            // cancellation of its own receive loop, which is the link going and not the engine
            // stopping.
            _log.LogWarning(ex,
                "The alert engine could not apply its rule subscriptions. It will try again.");
        }
    }

    private void Publish() => Volatile.Write(ref _snapshot, _core.Snapshot());

    private async Task AnnounceDropsAsync(int dropped, CancellationToken ct)
    {
        if (dropped == _announced) return;

        _announced = dropped;
        _console?.Dropped(dropped);

        try
        {
            await _notifier.DroppedAsync(dropped);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
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
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
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
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
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
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            // A hand-over, not a record. Losing it costs one round of resolved bodies and a few
            // mutes; refusing to start over it would cost every alert from now until somebody
            // notices, which is the trade the rules file makes in the opposite direction and for
            // a reason that does not apply here.
            _log.LogError(ex, "The alert state could not be read. The engine is starting with none.");

            return null;
        }
    }

    // Each channel is told the events in the order they happened, a run of one kind per call.
    //
    // Every channel's catch lets a cancellation through only when it is the engine stopping, the
    // rule SyncSubscriptionsAsync keeps and for its reason. No channel is handed the engine's token,
    // so a cancellation from one is that channel giving up — a send called off, a queue closing —
    // and not a reason to skip the channel after it, or the rest of the turn.
    private async Task DeliverAsync(IReadOnlyList<AlertEvent> events, CancellationToken ct)
    {
        if (events.Count == 0) return;

        try
        {
            foreach (var (raised, alerts) in AlertEvent.Runs(events))
                await (raised ? _notifier.RaisedAsync(alerts) : _notifier.ResolvedAsync(alerts));
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            // Telling is downstream of judging. A webhook endpoint that has gone away, or a hub
            // with no clients, must not stop this engine noticing the next thing that goes wrong.
            _log.LogError(ex, "An alert notifier threw. The alerts it was given were not delivered.");
        }

        // The console's half, handed to the loop that sends it and never waited for here: a frame
        // to a console that has stopped reading waits as long as its connection lasts.
        _console?.Alerts(events);

        // After the console and in its own try, both deliberately. The console is the fast local
        // channel and a screen notice must not wait behind a POST; and a fault in any of them is a
        // fault in one channel, never in another and never in the pump.
        await DispatchAsync(events, ct);
    }

    /// <summary>Hands on the alerts whose rules asked for something outside this process.</summary>
    private async Task DispatchAsync(IReadOnlyList<AlertEvent> events, CancellationToken ct)
    {
        if (_dispatcher is null) return;

        // Cut into runs after the screen-only alerts are taken out, so an alert the dispatcher never
        // sees cannot split one of its calls in two.
        var leaving = Outgoing(events);
        if (leaving.Count == 0) return;

        try
        {
            foreach (var (raised, alerts) in AlertEvent.Runs(leaving))
                await (raised ? _dispatcher.RaisedAsync(alerts) : _dispatcher.ResolvedAsync(alerts));
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
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
    private static IReadOnlyList<AlertEvent> Outgoing(IReadOnlyList<AlertEvent> events)
    {
        List<AlertEvent>? outgoing = null;

        foreach (var one in events)
            foreach (var action in one.Alert.Actions)
                if (action is WebhookAction or PublishAction)
                {
                    (outgoing ??= []).Add(one);
                    break;
                }

        return outgoing ?? [];
    }
}
