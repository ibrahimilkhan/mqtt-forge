using System.Threading.Channels;
using Microsoft.Extensions.Logging;
using MqttForge.Application.Alerts;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Flows;

/// <summary>
/// The transport around <see cref="FlowRuntime"/>: one bounded queue, one loop that is both the
/// pump and the timer, a second loop that publishes, and the flows' own subscriptions.
/// </summary>
// AlertEngine's shape, taken whole and for its reasons. The runtime is pure and holds every fact
// about a flow; this class holds nothing but the carrying — a queue, a clock, what was last pushed
// to the console — and the moment a field here becomes a fact about a flow it belongs there.
//
// One difference, and it is the reason there are two loops. A Publish node is the only thing in
// the product that sends to the broker because of a message the broker sent, at up to fifty a
// second per flow, and MQTTnet's publish waits for the broker's answer at QoS 1. Awaiting that on
// the pump would make every flow — and every alarm they raise — as slow as the slowest round trip.
// So publishes are handed to a channel of their own, sent in order by a loop that waits for
// nothing else, and a failure comes back to the pump as a command, where the counters live.
public sealed class FlowEngine
{
    public FlowEngine(FlowRuntime runtime, IFlowStore store, IAlertNotifier notifier, IFlowNotifier console,
                      IMqttConnectionManager connection, IMqttSubscriber subscriber, IMqttPublisher publisher,
                      AlertEngineOptions options, ILogger<FlowEngine> log,
                      TimeProvider? timeProvider = null, IAlertDispatcher? dispatcher = null)
    {
        _runtime = runtime;
        _store = store;
        _notifier = notifier;
        _console = console;
        _connection = connection;
        _subscriber = subscriber;
        _publisher = publisher;
        _prefix = options.TopicPrefix;
        _log = log;
        _time = timeProvider ?? TimeProvider.System;
        _dispatcher = dispatcher;

        _queue = Channel.CreateBounded<FlowCommand>(
            new BoundedChannelOptions(QueueCapacity) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true },
            OnDropped);

        // Wait rather than DropOldest, and written to with TryWrite only: a full outbox refuses the
        // newest publish, which the pump counts on the node that asked for it. Dropping the oldest
        // instead would lose a publish nobody could then name.
        _outbox = Channel.CreateBounded<FlowPublish>(
            new BoundedChannelOptions(OutboxCapacity) { FullMode = BoundedChannelFullMode.Wait, SingleReader = true, SingleWriter = true });

        _nextTick = _time.GetUtcNow() + TickInterval;
    }

    /// <summary>AlertEngine's figure and its bargain: past this the oldest go, and are counted.</summary>
    public const int QueueCapacity = 32_768;

    /// <summary>Publishes waiting for the broker. Twenty seconds of every flow at its limit.</summary>
    public const int OutboxCapacity = 1_024;

    /// <summary>How often the pump looks at the link with nothing else to wake it.</summary>
    public static readonly TimeSpan TickInterval = TimeSpan.FromSeconds(1);

    /// <summary>How long one publish may take before it is counted as failed.</summary>
    public static readonly TimeSpan PublishTimeout = TimeSpan.FromSeconds(5);

    private const int MaxPerTurn = 4_096;

    /// <summary>The QoS the flows' subscriptions ask for — AlertEngine's RuleQos, for its reason.</summary>
    private const int FlowQos = 1;

    private readonly FlowRuntime _runtime;
    private readonly IFlowStore _store;
    private readonly IAlertNotifier _notifier;
    private readonly IFlowNotifier _console;
    private readonly IMqttConnectionManager _connection;
    private readonly IMqttSubscriber _subscriber;
    private readonly IMqttPublisher _publisher;
    private readonly string _prefix;
    private readonly ILogger<FlowEngine> _log;
    private readonly TimeProvider _time;
    private readonly IAlertDispatcher? _dispatcher;
    private readonly Channel<FlowCommand> _queue;
    private readonly Channel<FlowPublish> _outbox;

    /// <summary>Filters this broker has refused on this link. Not asked for again until the link or the flows change.</summary>
    private readonly HashSet<string> _refused = new(StringComparer.Ordinal);

    private readonly List<FlowDebugEntry> _debug = [];

    private FlowStatus _status = FlowStatus.Empty;
    private FlowAlarms _alarms = FlowAlarms.Empty;
    private IReadOnlySet<(string FlowId, string NodeId)> _injectable = new HashSet<(string, string)>();
    private int _dropped;
    private int _debugDropped;
    private long _pushed = -1;
    private DateTimeOffset _lastPush = DateTimeOffset.MinValue;
    private DateTimeOffset? _pushDue;
    private DateTimeOffset _nextTick;
    private bool _linkWasUp;
    private bool _resubscribe;

    /// <summary>What the flows have done, as last pushed. What GET /api/flows/status answers.</summary>
    public FlowStatus Status => Volatile.Read(ref _status);

    /// <summary>The flow alarms, as GET /api/alerts merges them in.</summary>
    public FlowAlarms Alarms => Volatile.Read(ref _alarms);

    /// <summary>Commands the queue had to discard because the engine could not keep up.</summary>
    public int Dropped => Volatile.Read(ref _dropped);

    /// <summary>Whether a running flow has this Inject node — the inject endpoint's 404 question.</summary>
    public bool CanInject(string flowId, string nodeId) => Volatile.Read(ref _injectable).Contains((flowId, nodeId));

    /// <summary>Hands a command to the pump. Never blocks and never throws.</summary>
    public void Post(FlowCommand command) => _queue.Writer.TryWrite(command);

    /// <summary>The fan-out's entry point: queue it and get out of the receive loop's way.</summary>
    public Task NotifyMessageReceivedAsync(MqttMessage message)
    {
        Post(new FlowArrival(message));
        return Task.CompletedTask;
    }

    /// <summary>Reads the flows, starts the ones that compile, and puts their subscriptions up. Once, before the pump.</summary>
    public async Task StartAsync(CancellationToken ct)
    {
        var document = await LoadAsync(ct);
        var set = FlowCompiler.CompileAll(document.Flows, _prefix);

        foreach (var problem in set.Problems)
            _log.LogWarning("Flow {Flow} does not compile, so it is not running: {Problem}",
                problem.FlowId, problem.Problem.Message);

        var now = _time.GetUtcNow();
        _linkWasUp = _connection.State == ConnectionState.Connected;

        var outcome = FlowOutcome.Merge([_runtime.Deploy(set.Compiled, set.Kept, now), _runtime.OnTick(now, _linkWasUp)]);
        Volatile.Write(ref _injectable, _runtime.Injectable());

        _resubscribe = true;
        await CarryOutAsync(outcome, now);
        await SyncSubscriptionsAsync(ct);
        await PushAsync(now, force: true);
    }

    /// <summary>The pump and the timer, in one loop, for the life of the process.</summary>
    public async Task RunAsync(CancellationToken ct)
    {
        var sending = SendAsync(ct);
        var reader = _queue.Reader;

        // Held across iterations for AlertEngine's reason: a wait that loses the race is still a
        // live wait on the same reader, and a fresh one per turn would pile up registrations.
        var ready = reader.WaitToReadAsync(ct).AsTask();

        try
        {
            while (!ct.IsCancellationRequested)
            {
                await TurnAsync(ct);

                var wait = Wake() - _time.GetUtcNow();
                if (wait < TimeSpan.Zero) wait = TimeSpan.Zero;

                // The delay is what makes time an event: an Every due in 100 ms and a status push due
                // in 250 ms both have to happen with no message arriving to prompt them.
                var woken = await Task.WhenAny(ready, Task.Delay(wait, _time));

                if (woken == ready)
                {
                    if (!await ready) break;
                    ready = reader.WaitToReadAsync(ct).AsTask();
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Shutdown.
        }
        finally
        {
            _outbox.Writer.TryComplete();

            try
            {
                await sending;
            }
            catch (OperationCanceledException)
            {
                // The publish loop was cancelled with the same token; what it still held goes with the process.
            }
        }
    }

    private DateTimeOffset Wake()
    {
        var wake = _nextTick;
        if (_runtime.NextDue is { } due && due < wake) wake = due;
        if (_pushDue is { } push && push < wake) wake = push;
        return wake;
    }

    /// <summary>One turn: drain what is queued, let the clock and the link move, carry out, tell.</summary>
    private async Task TurnAsync(CancellationToken ct)
    {
        try
        {
            var outcomes = new List<FlowOutcome>();
            var handled = 0;

            while (handled < MaxPerTurn && _queue.Reader.TryRead(out var command))
            {
                handled++;
                outcomes.Add(Apply(command, _time.GetUtcNow()));
            }

            var now = _time.GetUtcNow();
            if (now >= _nextTick) _nextTick = now + TickInterval;

            // Read every turn rather than only on the tick: it is a property read, and a flow that
            // publishes on an Every should find out the link went the turn it went.
            var connected = _connection.State == ConnectionState.Connected;
            if (connected && !_linkWasUp)
            {
                // Subscriptions die with the connection, and a new link is a new answer to a refusal.
                _resubscribe = true;
                _refused.Clear();
            }

            _linkWasUp = connected;
            outcomes.Add(_runtime.OnTick(now, connected));

            if (_resubscribe) await SyncSubscriptionsAsync(ct);

            await CarryOutAsync(FlowOutcome.Merge(outcomes), now);
            await PushAsync(now, force: false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            // Nothing escapes the pump, AlertEngine's rule: a fault nobody predicted is still not a
            // reason to stop every flow in the product.
            //
            // That includes a cancellation nobody here asked for. RunAsync reads any cancellation
            // that reaches it as shutdown, so one that came from somewhere else — a hub send that
            // gave up, a library tearing its own link down — would end the pump for good, with the
            // process still running, every flow stopped, and not a line in the log to say so.
            _log.LogError(ex, "A turn of the flow engine failed. The engine is carrying on.");
        }
    }

    private FlowOutcome Apply(FlowCommand command, DateTimeOffset now)
    {
        switch (command)
        {
            case FlowArrival arrival:
                return _runtime.OnMessage(arrival.Message, now);

            case FlowDeploy deploy:
                var outcome = _runtime.Deploy(deploy.Flows, deploy.Kept, now);
                Volatile.Write(ref _injectable, _runtime.Injectable());

                // New flows, new filters — and a filter the broker refused is worth asking about
                // again once somebody has edited the flow that wanted it.
                _resubscribe = true;
                _refused.Clear();
                return outcome;

            case FlowInject inject:
                return _runtime.Inject(inject.FlowId, inject.NodeId, now);

            case FlowPublishFailed failed:
                return _runtime.PublishFailed(failed.FlowId, failed.NodeId, failed.Reason, now);

            default:
                _log.LogWarning("The flow engine does not know what to do with a {Command}.", command.GetType().Name);
                return FlowOutcome.Empty;
        }
    }

    private async Task CarryOutAsync(FlowOutcome outcome, DateTimeOffset now)
    {
        if (outcome.IsEmpty) return;

        var debug = new List<FlowDebugEntry>(outcome.Debug);

        foreach (var publish in outcome.Publishes)
            if (!_outbox.Writer.TryWrite(publish))
                debug.AddRange(_runtime.PublishFailed(publish.FlowId, publish.NodeId,
                    "Too many publishes were waiting for the broker; this one was dropped.", now).Debug);

        foreach (var entry in debug)
        {
            if (_debug.Count < FlowLimits.DebugPerPush) _debug.Add(entry);
            else _debugDropped++;
        }

        if (outcome.Raised.Count == 0 && outcome.Resolved.Count == 0) return;

        // Before the telling, AlertEngine's order: a console that reacts to alertsRaised by reading
        // GET /api/alerts has to find the alarm already there, or the badge flickers back to nothing.
        Volatile.Write(ref _alarms, _runtime.Alarms());
        await DeliverAsync(outcome.Raised, outcome.Resolved);
    }

    private async Task DeliverAsync(IReadOnlyList<Alert> raised, IReadOnlyList<Alert> resolved)
    {
        try
        {
            if (raised.Count > 0) await _notifier.RaisedAsync(raised);
            if (resolved.Count > 0) await _notifier.ResolvedAsync(resolved);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.LogError(ex, "An alert notifier threw. The flow alarms it was given were not delivered.");
        }

        if (_dispatcher is null) return;

        var leaving = Outgoing(raised);
        var leavingResolved = Outgoing(resolved);
        if (leaving.Count == 0 && leavingResolved.Count == 0) return;

        try
        {
            if (leaving.Count > 0) await _dispatcher.RaisedAsync(leaving);
            if (leavingResolved.Count > 0) await _dispatcher.ResolvedAsync(leavingResolved);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.LogError(ex, "An alert dispatcher threw. The flow alarms it was given were not delivered.");
        }
    }

    /// <summary>The alarms whose node asked for a channel outside this process — AlertEngine's filter.</summary>
    private static IReadOnlyList<Alert> Outgoing(IReadOnlyList<Alert> alerts) =>
        [.. alerts.Where(alert => alert.Actions.Any(action => action is WebhookAction or PublishAction))];

    /// <summary>Tells the console what moved, at most four times a second.</summary>
    private async Task PushAsync(DateTimeOffset now, bool force)
    {
        var moved = _runtime.Version != _pushed || _debug.Count > 0 || _debugDropped > 0;
        if (!moved)
        {
            _pushDue = null;
            return;
        }

        if (!force && now - _lastPush < FlowLimits.StatusEvery)
        {
            _pushDue = _lastPush + FlowLimits.StatusEvery;
            return;
        }

        _pushDue = null;
        _lastPush = now;
        _pushed = _runtime.Version;

        var status = _runtime.Status();
        Volatile.Write(ref _status, status);
        Volatile.Write(ref _alarms, _runtime.Alarms());

        var debug = _debug.ToList();
        var dropped = _debugDropped;
        _debug.Clear();
        _debugDropped = 0;

        try
        {
            await _console.StatusAsync(status);
            if (debug.Count > 0 || dropped > 0) await _console.DebugAsync(debug, dropped);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.LogWarning(ex, "Could not tell the console what the flows are doing.");
        }
    }

    /// <summary>The publish loop: in order, one at a time, each with its own deadline.</summary>
    private async Task SendAsync(CancellationToken ct)
    {
        try
        {
            await foreach (var publish in _outbox.Reader.ReadAllAsync(ct))
            {
                using var deadline = new CancellationTokenSource(PublishTimeout, _time);
                using var either = CancellationTokenSource.CreateLinkedTokenSource(ct, deadline.Token);

                try
                {
                    await _publisher.PublishAsync(publish.Request, either.Token);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    Post(new FlowPublishFailed(publish.FlowId, publish.NodeId, Why(ex, deadline.IsCancellationRequested)));
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Shutdown.
        }
    }

    // The deadline says whether a publish timed out, not the exception's type. MQTTnet 5 answers a
    // wait that was called off with its own MqttCommunicationTimedOutException, never with a
    // cancellation, so a timeout read from the type would reach the node as "The publish failed:
    // The operation has timed out." And a cancellation that is neither the deadline nor shutdown is
    // MQTTnet failing what was in flight when it tore its own link down.
    private static string Why(Exception ex, bool timedOut) => ex switch
    {
        _ when timedOut => $"The broker did not take the publish within {PublishTimeout.TotalSeconds:0} seconds.",
        NotConnectedException => "No broker link, so nothing was published.",
        OperationCanceledException => "The link went before the broker took the publish.",
        MessageRejectedException rejected => rejected.Message,
        _ => $"The publish failed: {ex.Message}",
    };

    /// <summary>AlertEngine.SyncSubscriptionsAsync, for the flows' own filters and owner.</summary>
    // A diff and not a refresh, for that method's reason: re-sending the whole set would have the
    // broker replay every retained value under every filter on every deploy.
    private async Task SyncSubscriptionsAsync(CancellationToken ct)
    {
        if (_connection.State != ConnectionState.Connected) return;

        var wanted = _runtime.Filters();

        var held = new HashSet<string>(StringComparer.Ordinal);
        foreach (var filter in _subscriber.Filters)
            if (filter.Owners.HasFlag(SubscriptionOwner.Flows))
                held.Add(filter.Filter);

        var missing = wanted.Where(filter => !held.Contains(filter) && !_refused.Contains(filter))
            .Select(filter => new SubscriptionRequest(filter, FlowQos))
            .ToList();
        var gone = held.Where(filter => !wanted.Contains(filter)).ToList();

        try
        {
            if (missing.Count > 0) await _subscriber.SubscribeAsync(missing, ct, SubscriptionOwner.Flows);
            foreach (var filter in gone) await _subscriber.UnsubscribeAsync(filter, ct, SubscriptionOwner.Flows);

            _resubscribe = false;
        }
        catch (MessageRejectedException refusal)
        {
            var refused = refusal.Filters.Count > 0
                ? refusal.Filters
                : [.. missing.Select(request => request.TopicFilter)];

            foreach (var filter in refused) _refused.Add(filter);
            _runtime.MarkRefused(refused);

            _log.LogWarning(refusal,
                "The broker refused {Count} flow filter(s); they will not be asked for again on this link.",
                refused.Count);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            // A link that went mid-packet, a broker that never answered: the flag stays up and the
            // next turn asks again.
            //
            // A cancellation is one of these unless it is this pump's own. MQTTnet 5 can fail a
            // SUBSCRIBE that was waiting when its keep-alive gave up on the link with the
            // cancellation of its own receive loop — the link going, not the engine stopping — and
            // letting that through would also lose everything else the turn had decided.
            _log.LogWarning(ex, "The flow engine could not apply its subscriptions. It will try again.");
        }
    }

    private async Task<FlowDocument> LoadAsync(CancellationToken ct)
    {
        try
        {
            var document = await _store.LoadAsync(ct);
            if (document.Unreadable)
                _log.LogError("The flows file could not be read, so no flows are running.");

            return document;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // A monitoring tool that refuses to start over an unreadable file is not monitoring.
            _log.LogError(ex, "The flows could not be loaded, so no flows are running.");
            return new FlowDocument([], Unreadable: true);
        }
    }

    private void OnDropped(FlowCommand command)
    {
        Interlocked.Increment(ref _dropped);

        if (command is not FlowArrival)
            _log.LogWarning("The flow engine's queue was full and dropped a {Command}.", command.GetType().Name);
    }
}
