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
/// pump and the timer, a second loop that publishes, a third that tells the console, and the
/// flows' own subscriptions.
/// </summary>
// AlertEngine's shape, taken whole and for its reasons. The runtime is pure and holds every fact
// about a flow; this class holds nothing but the carrying — a queue, a clock, what was last pushed
// to the console — and the moment a field here becomes a fact about a flow it belongs there.
//
// One difference, and it is the reason there are more loops than one. A Publish node is the only
// thing in the product that sends to the broker because of a message the broker sent, at up to
// fifty a second per run, and MQTTnet's publish waits for the broker's answer at QoS 1. Awaiting
// that on the pump would make every flow — and every alarm they raise — as slow as the slowest
// round trip. So publishes are handed to a channel of their own, sent in order by a loop that waits
// for nothing else, and a failure comes back to the pump as a command, where the counters live. A
// Webhook node's post goes the same way, to IFlowWebhook's queue. The console's pushes go the same
// way, for the same reason, and so does its half of every alarm: see FlowConsoleSender. The notifier
// this class is handed is told on the pump, so it has to be one that waits on nothing — in production
// the log; the console is told through IFlowNotifier, from that loop.
public sealed class FlowEngine
{
    public FlowEngine(FlowRuntime runtime, IFlowStore store, IAlertNotifier notifier, IFlowNotifier console,
                      IMqttConnectionManager connection, IMqttSubscriber subscriber, IMqttPublisher publisher,
                      AlertEngineOptions options, ILogger<FlowEngine> log,
                      TimeProvider? timeProvider = null, IFlowWebhook? webhook = null)
    {
        _runtime = runtime;
        _store = store;
        _notifier = notifier;
        _pushes = new FlowConsoleSender(console, log);
        _connection = connection;
        _publisher = publisher;
        _prefix = options.TopicPrefix;
        _log = log;
        _time = timeProvider ?? TimeProvider.System;
        _webhook = webhook;
        _filters = new FilterSync(subscriber, SubscriptionOwner.Flows, FlowQos, _time, log, "flow");

        _queue = Channel.CreateBounded<Queued>(
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

    /// <summary>How many commands one turn takes before it looks at the clock. AlertEngine's figure.</summary>
    // For its reason: a firehose would otherwise keep one turn draining for ever, and nothing that
    // is due — a Wait that has ended, a push, the look at the link — would ever run.
    public const int MaxPerTurn = 4_096;

    /// <summary>The QoS the flows' subscriptions ask for — AlertEngine's RuleQos, for its reason.</summary>
    private const int FlowQos = 1;

    private readonly FlowRuntime _runtime;
    private readonly IFlowStore _store;
    private readonly IAlertNotifier _notifier;
    private readonly FlowConsoleSender _pushes;
    private readonly IMqttConnectionManager _connection;
    private readonly IMqttPublisher _publisher;
    private readonly string _prefix;
    private readonly ILogger<FlowEngine> _log;
    private readonly TimeProvider _time;
    private readonly IFlowWebhook? _webhook;
    private readonly Channel<Queued> _queue;
    private readonly Channel<FlowPublish> _outbox;

    /// <summary>The flows' filters at the broker, and what it refused of them on this link: AlertEngine's, under the flows' own owner.</summary>
    private readonly FilterSync _filters;

    // The deploy the pump has not reached yet, and the order everything posted is stamped in. See Hand.
    private readonly Lock _deploying = new();
    private PendingDeploy? _pending;
    private long _stamp;

    private readonly List<FlowDebugEntry> _debug = [];

    private FlowStatus _status = FlowStatus.Empty;
    private FlowAlarms _alarms = FlowAlarms.Empty;

    // Which flows are switched on and which are being tested, as the pump last left them: what the
    // service reads before posting a test's Stop, and what a caller reads once its save is answered.
    private IReadOnlySet<string> _active = new HashSet<string>();
    private IReadOnlySet<string> _testing = new HashSet<string>();

    // What the runs wanted at the last look. A run that ends gives its filters back and one that starts
    // may want new ones, and either is a change only a deploy used to make.
    private IReadOnlySet<string> _wanted = new HashSet<string>();

    private int _dropped;
    private int _debugDropped;
    private long _pushed = -1;
    private DateTimeOffset _lastPush = DateTimeOffset.MinValue;
    private DateTimeOffset? _pushDue;
    private DateTimeOffset _nextTick;
    private bool _linkWasUp;
    private bool _resubscribe;

    /// <summary>Which broker the flows are running against, as host:port, when that is known.</summary>
    // AlertEngine's _learnedFrom, for the move to another broker that no turn of the pump sees.
    private string? _linkedTo;

    /// <summary>When the link the pump last looked at came up: AlertEngine's, for a redial no turn saw.</summary>
    private DateTimeOffset? _linkedAt;

    /// <summary>Every run there is, as last pushed. What GET /api/flows/status answers.</summary>
    public FlowStatus Status => Volatile.Read(ref _status);

    /// <summary>The flow alarms, as GET /api/alerts merges them in.</summary>
    public FlowAlarms Alarms => Volatile.Read(ref _alarms);

    /// <summary>Commands the queue had to discard because the engine could not keep up.</summary>
    public int Dropped => Volatile.Read(ref _dropped);

    /// <summary>Whether a flow is switched on — has an active run, going or finished — as the pump last left it.</summary>
    public bool IsActive(string flowId) => Volatile.Read(ref _active).Contains(flowId);

    /// <summary>Whether a flow has a test run that has not ended, as the pump last left it.</summary>
    public bool IsTesting(string flowId) => Volatile.Read(ref _testing).Contains(flowId);

    private void Snapshot()
    {
        Volatile.Write(ref _active, _runtime.Active());
        Volatile.Write(ref _testing, _runtime.Testing());
    }

    /// <summary>Hands a command to the pump. Never blocks and never throws.</summary>
    public void Post(FlowCommand command)
    {
        if (command is FlowDeploy deploy)
        {
            Hand(deploy);
            return;
        }

        _queue.Writer.TryWrite(new Queued(Interlocked.Increment(ref _stamp), command));
    }

    /// <summary>How long a deploy's answer waits for the pump to be running it.</summary>
    // Long enough for a pump held up for a moment — a turn telling its alarms to a slow channel, a
    // broker slow to answer a SUBSCRIBE — and short enough that a pump stuck on one does not leave
    // the console's Activate or Update waiting with it. PublishTimeout's figure.
    public static readonly TimeSpan DeployPatience = TimeSpan.FromSeconds(5);

    /// <summary>
    /// Hands the pump what should run now, and answers once it is running it: true, or false when
    /// <see cref="DeployPatience"/> ran out first — the deploy is not lost, and runs when the pump
    /// is free.
    /// </summary>
    // Handed over before it returns, so a caller can hold a lock around the handing over alone and wait
    // for the answer outside it.
    public Task<bool> DeployAsync(FlowDeploy deploy, CancellationToken ct) => AnsweredAsync(Hand(deploy), ct);

    // Apart from DeployAsync, whose parameters an await would keep for as long as it waits: the wait
    // holds the answer and not the deploy, which a newer one may replace in its slot meanwhile.
    private async Task<bool> AnsweredAsync(Task<bool> running, CancellationToken ct)
    {
        try
        {
            return await running.WaitAsync(DeployPatience, _time, ct);
        }
        catch (TimeoutException)
        {
            _log.LogWarning("The flow engine was busy for {Seconds} seconds, so a deploy was answered before it ran. " +
                            "It runs as soon as the engine is free.", DeployPatience.TotalSeconds);
            return false;
        }
    }

    /// <summary>Puts a deploy where the queue cannot lose it, and its place in the queue's order.</summary>
    // A deploy is the whole of what should run, so it has a slot of its own: the queue lets its oldest
    // entry go when it is full, and a deploy it let go was a file saying one thing and an engine running
    // another until the next deploy or restart. A deploy the pump has not reached yet is simply replaced
    // by a newer one, which is everything the older said and more, and takes the older one's place in
    // the order: every command posted after the first of them meets flows at least that new.
    //
    // The queue still gets an entry, which is the pump's wake-up and nothing else — nothing of the
    // deploy, so a replaced one is held by nothing, however long the pump takes to read its entry. If
    // the queue has to let that entry go, it was full, the pump is draining it, and the slot is found
    // all the same.
    private Task<bool> Hand(FlowDeploy deploy)
    {
        Task<bool> running;
        lock (_deploying)
        {
            _pending ??= new PendingDeploy(Interlocked.Increment(ref _stamp));
            _pending.Deploy = deploy;
            running = _pending.Running.Task;
        }

        _queue.Writer.TryWrite(new Queued(Interlocked.Increment(ref _stamp), DeployWaiting.Marker));
        return running;
    }

    /// <summary>The deploy waiting in its slot, if it was handed over before the command stamped <paramref name="before"/>.</summary>
    private PendingDeploy? TakeDeploy(long before)
    {
        if (Volatile.Read(ref _pending) is null) return null;

        lock (_deploying)
        {
            if (_pending is not { } pending || pending.Stamp > before) return null;

            _pending = null;
            return pending;
        }
    }

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
        _linkedTo = _linkWasUp ? EndpointOf(_connection.Link) : null;
        _linkedAt = _linkWasUp ? _connection.Link?.ConnectedAt : null;

        // The link first. A deploy runs each flow up to its first wait, and the runtime takes the link to
        // be down until a tick says otherwise: told second, every publish a flow makes before its first
        // Wait or MQTT in would be refused with "No broker link" with the link up.
        var outcome = FlowOutcome.Merge([_runtime.OnTick(now, _linkWasUp), _runtime.Deploy(set.Compiled, set.Kept, now)]);
        Snapshot();

        _resubscribe = true;
        _wanted = _runtime.Filters();
        await CarryOutAsync(outcome, now, ct);
        await SyncSubscriptionsAsync(ct);
        Push(now, force: true);
    }

    /// <summary>The pump and the timer, in one loop, for the life of the process.</summary>
    public async Task RunAsync(CancellationToken ct)
    {
        var sending = SendAsync(ct);

        // The console's loop, started and stopped with the pump: what the pump pushes is sent from
        // there, so no console, however slow, is ever something the pump waits for.
        var telling = _pushes.RunAsync(ct);
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

                // Never longer than a tick, whatever the clock says. Everything the pump waits for is
                // at most a tick away by the clock the turn read, so a longer wait can only mean the
                // clock was set back since — in the middle of the turn, where no turn is left to put
                // it right — and sleeping it out would leave the link unwatched for as long as the
                // clock went back. Past 49 days Task.Delay would throw, here where no catch keeps the
                // pump alive.
                if (wait > TickInterval) wait = TickInterval;

                // The delay is what makes time an event: a Wait that ends in 100 ms and a status push
                // due in 250 ms both have to happen with no message arriving to prompt them.
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
            _pushes.Complete();

            try
            {
                await sending;
            }
            catch (OperationCanceledException)
            {
                // The publish loop was cancelled with the same token; what it still held goes with the process.
            }

            // Ends on the same token, which calls off a send a console was sitting on.
            await telling;
        }
    }

    /// <summary>What a new link, or a link to another broker, asks of the engine.</summary>
    // Subscriptions die with the connection, and a new link is a new answer to a refusal. The broker
    // is taken as the link says, unknown included: a link up before the manager has said where to
    // must not be taken for a move when it does.
    private void NewLink(string? endpoint)
    {
        _resubscribe = true;
        _filters.NewLink();
        _linkedTo = endpoint;
    }

    private static string? EndpointOf(BrokerLink? link) => link is null ? null : $"{link.Host}:{link.Port}";

    /// <summary>Tells the runtime of a move to <paramref name="to"/>, and takes that as a new link.</summary>
    private FlowOutcome Move(BrokerLink to)
    {
        NewLink(EndpointOf(to));
        return _runtime.OnMove(_time.GetUtcNow());
    }

    /// <summary>Whether a command falls after the move to <paramref name="link"/>, so the move is told before it.</summary>
    // A step's failure falls on neither side. Its node counts it whichever link is up, and a publish
    // may well have been in flight on the old link when that went — so it must not be what puts the
    // old broker's messages queued behind it on the new broker's side.
    private static bool FallsAfter(FlowCommand command, BrokerLink link) => command switch
    {
        FlowArrival { Message: { } message } => message.ReceivedAt >= link.ConnectedAt,
        FlowStepFailed => false,
        _ => true,
    };

    /// <summary>Whether a filter the running flows want, and the broker has not refused, is not held for them.</summary>
    private bool FiltersMissing() => _filters.Missing(_runtime.Filters());

    private DateTimeOffset Wake()
    {
        var wake = _nextTick;
        if (_runtime.NextDue is { } due && due < wake) wake = due;
        if (_pushDue is { } push && push < wake) wake = push;
        return wake;
    }

    /// <summary>One turn: the link, what is queued, the clock and the filters; then carry out, and tell.</summary>
    private async Task TurnAsync(CancellationToken ct)
    {
        try
        {
            var outcomes = new List<FlowOutcome>();

            // Read every turn rather than only on the tick: it is a property read, and a flow that
            // publishes after a Wait should find out the link went the turn it went.
            //
            // Read before the queue, and told to the runtime lopsidedly: up before the commands are
            // applied, down only after them. Up first because the runtime refuses every publish until
            // it has been told the link is up, and a redial puts the console's own filters back before
            // the flows' — so an arrival a flow listens for can be in this very turn's queue, or a
            // Test, and either would be refused with a "No broker link" that was no longer true.
            // Down last because whatever is queued arrived while the link was there, and is judged
            // as such before "connection ended" takes its alarms away.
            var connected = _connection.State == ConnectionState.Connected;
            var link = connected ? _connection.Link : null;
            var endpoint = EndpointOf(link);

            // Whether the link came up since the last look, told by when it came up: AlertEngine's
            // Relinked, and all that tells two links to one broker apart.
            var relinked = link is not null && _linkedAt is { } seen && seen != link.ConnectedAt;
            if (link is not null) _linkedAt = link.ConnectedAt;

            if (connected && !_linkWasUp)
            {
                outcomes.Add(_runtime.OnTick(_time.GetUtcNow(), connected: true));
                _linkWasUp = true;
                NewLink(endpoint);
            }
            // A link that went and came back to the same broker between two turns, which no turn saw
            // down. A new link all the same: the flows' filters went with the old one, and a pause the
            // broker left on the old one is not this one's. One to another broker is a move, below.
            else if (relinked && endpoint == _linkedTo)
            {
                NewLink(endpoint);
            }

            // A move to another broker that no turn saw. MqttnetConnectionManager goes from one live
            // link to the next in one call and is other than Connected only for the handshake — tens
            // of milliseconds against a poll up to a second apart. It is a down and an up all the
            // same: the alarms standing were about a plant seen through the other broker, the flows'
            // filters went with the old link, and a refusal was the other broker's answer.
            //
            // Told where it falls in the queue. After the queue, it ended at once the alarms the new
            // broker's first arrivals raised; before it, the old broker's last arrivals would be judged
            // as the new one's and left standing there. The line is the new link's ConnectedAt, which
            // ReceivedAt can be held against: both are read from the system clock, MQTTnet hands over
            // the old link's last message before the manager may dial again, and a clean session is
            // sent nothing before it has subscribed, a round trip after it came up. What can still
            // misplace an arrival is a broker that kept the session and sends its backlog before the
            // link is stamped, or a clock set back in the middle of a move. A step that failed decides
            // nothing (FallsAfter says why); the other commands carry no time and act on the link
            // that is up now, so the move goes before the first of them.
            var moving = endpoint is not null && _linkedTo is not null && endpoint != _linkedTo ? link : null;
            if (moving is null && endpoint is not null) _linkedTo = endpoint;

            bool Handle(FlowCommand command)
            {
                if (moving is not null && FallsAfter(command, moving))
                {
                    outcomes.Add(Move(moving));
                    moving = null;
                }

                try
                {
                    outcomes.Add(Apply(command, _time.GetUtcNow()));
                    return true;
                }
                catch (Exception ex)
                {
                    // One command's fault, and confined to it. Nothing the product posts is known to
                    // throw here, but if one ever did, the turn's catch below would take every other
                    // command's outcome with it: publishes never sent, and alarms already in the book
                    // that nobody would ever be told about.
                    _log.LogError(ex, "The flow engine could not apply a {Command}, so it was skipped.",
                        command.GetType().Name);
                    return false;
                }
            }

            // Answered once it has been applied, whoever handed it over and however many of them it
            // stands for.
            void Deploy(PendingDeploy pending) => pending.Running.TrySetResult(Handle(pending.Deploy));

            var handled = 0;
            while (handled < MaxPerTurn && _queue.Reader.TryRead(out var queued))
            {
                handled++;

                // A deploy goes in at its own place, whether or not the queue kept its entry: ahead of
                // the first command posted after it. The entry itself is its wake-up and nothing more.
                if (TakeDeploy(before: queued.Stamp) is { } pending) Deploy(pending);
                if (queued.Command is not DeployWaiting) Handle(queued.Command);
            }

            // One handed over after everything the turn read, or whose entry the queue let go with
            // nothing after it. A turn that stopped at its limit leaves it for the next, which reads
            // on to its place first.
            if (handled < MaxPerTurn && TakeDeploy(before: long.MaxValue) is { } late) Deploy(late);

            // Nothing queued came after the move, so it goes after the queue, as any down does —
            // unless the turn stopped at its limit, when the next one sees the same move and goes on
            // through what is left of the old broker's arrivals first.
            if (moving is not null && handled < MaxPerTurn) outcomes.Add(Move(moving));

            var now = _time.GetUtcNow();

            // A clock set back — NTP pulling in one that ran fast, a virtual machine restored — would
            // otherwise leave the next push waiting for the last one's time to come round again, and
            // the next tick as far off as the clock went back: the console told nothing and the link
            // unwatched for as long as that is. Both are measured from now again instead.
            if (now < _lastPush) _lastPush = now;

            var tick = now >= _nextTick;
            if (tick || _nextTick - now > TickInterval) _nextTick = now + TickInterval;

            outcomes.Add(_runtime.OnTick(now, connected));
            Snapshot();
            _linkWasUp = connected;

            // What the turn decided goes out before the filters are looked at. That look reads the
            // subscriber and may wait on a SUBSCRIBE, so ahead of this it could lose the turn to the
            // catch below — alarms in the book nobody was told of, publishes never sent — or hold
            // all of it back until the broker answered.
            await CarryOutAsync(FlowOutcome.Merge(outcomes), now, ct);
            Push(now, force: false);

            // And filters that went with no transition to show for it — a link that dropped and came
            // back between two turns, a move whose new endpoint was not known yet. Once a tick, what
            // the flows want is held against what the subscriber is holding for them.
            if (tick && connected && !_resubscribe && FiltersMissing()) _resubscribe = true;

            var wanted = _runtime.Filters();
            if (!wanted.SetEquals(_wanted))
            {
                _wanted = wanted;
                _resubscribe = true;
            }

            if (_resubscribe && !_filters.Pausing(now))
            {
                var version = _runtime.Version;
                await SyncSubscriptionsAsync(ct);

                // A refusal is marked on its node after this turn's push has gone. Asked for again,
                // it goes out within the throttle's quarter second, where it would otherwise wait
                // for whatever woke the pump next: on a turn the clock woke, the next tick.
                if (_runtime.Version != version) Push(now, force: false);
            }
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
            {
                var outcome = _runtime.Deploy(deploy.Flows, deploy.Kept, now);
                Snapshot();

                // New flows, new filters, and whoever saved them is waiting to see them run: see
                // FilterSync.Changed.
                _resubscribe = true;
                _filters.Changed();
                return outcome;
            }

            case FlowTestStart test:
            {
                var outcome = _runtime.StartTest(test.Flow, now);
                Snapshot();

                // A deploy's reason, for the one flow: whoever pressed Test is waiting to see it read.
                _resubscribe = true;
                _filters.Changed();
                return outcome;
            }

            case FlowTestStop stop:
            {
                var outcome = _runtime.StopTest(stop.FlowId, now);
                Snapshot();
                _resubscribe = true;
                return outcome;
            }

            case FlowStepFailed failed:
                return _runtime.StepFailed(failed.Run, failed.Serial, failed.NodeId, failed.Reason, now);

            case FlowClearHistory:
                _runtime.ClearHistory();

                // At once rather than at the next push: GET /api/alerts reads this, and a console that
                // cleared the list and read it back would otherwise find it all still there.
                Volatile.Write(ref _alarms, _runtime.Alarms());
                return FlowOutcome.Empty;

            default:
                _log.LogWarning("The flow engine does not know what to do with a {Command}.", command.GetType().Name);
                return FlowOutcome.Empty;
        }
    }

    private async Task CarryOutAsync(FlowOutcome outcome, DateTimeOffset now, CancellationToken ct)
    {
        if (outcome.IsEmpty) return;

        var debug = new List<FlowDebugEntry>(outcome.Debug);

        foreach (var publish in outcome.Publishes)
            if (!_outbox.Writer.TryWrite(publish))
                debug.AddRange(_runtime.StepFailed(publish.Run, publish.Serial, publish.NodeId,
                    "Too many publishes were waiting for the broker; this one was dropped.", now).Debug);

        foreach (var post in outcome.Webhooks)
        {
            var refused = _webhook is null
                ? "Webhooks are turned off on this host (MqttForge:AllowWebhooks), so nothing was sent."
                : !_webhook.Post(post, reason => Post(new FlowStepFailed(post.Run, post.Serial, post.NodeId, reason)))
                    ? "Too many webhook posts were waiting; this one was dropped."
                    : null;

            if (refused is not null) debug.AddRange(_runtime.StepFailed(post.Run, post.Serial, post.NodeId, refused, now).Debug);
        }

        foreach (var entry in debug)
        {
            if (_debug.Count < FlowLimits.DebugPerPush) _debug.Add(entry);
            else _debugDropped++;
        }

        if (outcome.Alarms.Count > 0)
        {
            // Before the telling, AlertEngine's order: a console that reacts to alertsRaised by reading
            // GET /api/alerts has to find the alarm already there, or the badge flickers back to nothing.
            Volatile.Write(ref _alarms, _runtime.Alarms());
            await DeliverAsync(outcome.Alarms, ct);
        }

        // Moments, handed to the console's loop like every push and never waited for here — and after the
        // alarms they may be about. That loop runs beside the pump, and handed a tone first it would send
        // it while the log was still being told of the alarm, and the alarm after it.
        _pushes.Sounds(outcome.Sounds);
        _pushes.Notices(outcome.Notices);
    }

    // The notifier's catch lets a cancellation through only when it is the engine stopping, the rule
    // SyncSubscriptionsAsync keeps and for its reason. The notifier is not handed the engine's token, so
    // a cancellation from it is that channel giving up and not a reason to skip the console's half or
    // the rest of the turn.
    //
    // Those two halves are all a flow alarm is told to. Its actions are the screen alone, so nothing of
    // it is for a dispatcher: a flow that wants a webhook or a publish after an alarm draws the step.
    private async Task DeliverAsync(IReadOnlyList<AlertEvent> alarms, CancellationToken ct)
    {
        try
        {
            foreach (var (raised, alerts) in AlertEvent.Runs(alarms))
                await (raised ? _notifier.RaisedAsync(alerts) : _notifier.ResolvedAsync(alerts));
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            _log.LogError(ex, "An alert notifier threw. The flow alarms it was given were not delivered.");
        }

        // The console's half, handed to the loop that sends the pushes and never waited for here: an
        // alarm frame to a console that has stopped reading waits as long as a push to it does.
        _pushes.Alarms(alarms);
    }

    /// <summary>Hands the console what moved, at most four times a second. Never waits on it: see FlowConsoleSender.</summary>
    private void Push(DateTimeOffset now, bool force)
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
        Volatile.Write(ref _alarms, _runtime.Alarms());

        // Handed to the console's loop before it is published as Status, so whoever reads Status and
        // finds this picture finds it in that loop's hands already. The other way round, a loop that
        // woke between the two took the picture before it, while Status showed this one. Nothing
        // reads Status to learn what the loop was given; GET /api/flows/status is an answer of its own.
        _pushes.Status(status);
        if (_debug.Count > 0 || _debugDropped > 0) _pushes.Debug([.. _debug], _debugDropped);

        Volatile.Write(ref _status, status);

        _debug.Clear();
        _debugDropped = 0;
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
                    Post(new FlowStepFailed(publish.Run, publish.Serial, publish.NodeId, Why(ex, deadline.IsCancellationRequested)));
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

    /// <summary>AlertEngine.SyncSubscriptionsAsync, for the flows' own filters.</summary>
    private async Task SyncSubscriptionsAsync(CancellationToken ct)
    {
        if (_connection.State != ConnectionState.Connected) return;

        var (done, refused) = await _filters.SyncAsync(_runtime.Filters(), ct);
        if (done) _resubscribe = false;
        if (refused.Count > 0) _runtime.MarkRefused(refused);
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

    private void OnDropped(Queued queued)
    {
        // A deploy's entry is only its wake-up: the deploy itself is in its slot, and lost is what it is not.
        if (queued.Command is DeployWaiting) return;

        Interlocked.Increment(ref _dropped);

        if (queued.Command is not FlowArrival)
            _log.LogWarning("The flow engine's queue was full and dropped a {Command}.", queued.Command.GetType().Name);
    }

    /// <summary>A command, and when it was posted, as the order of everything posted.</summary>
    private readonly record struct Queued(long Stamp, FlowCommand Command);

    /// <summary>A deploy's entry in the queue: its place in the order, and the pump's wake-up. The deploy is in its slot.</summary>
    private sealed record DeployWaiting : FlowCommand
    {
        public static DeployWaiting Marker { get; } = new();
    }

    /// <summary>The newest deploy the pump has not reached, where the first of them was stamped, and everyone waiting on it.</summary>
    private sealed class PendingDeploy(long stamp)
    {
        public long Stamp { get; } = stamp;
        public FlowDeploy Deploy { get; set; } = null!;
        public TaskCompletionSource<bool> Running { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
}
