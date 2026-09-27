using Microsoft.Extensions.Time.Testing;
using MqttForge.Application.Flows;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using MqttForge.UnitTests.Application.Alerts;

namespace MqttForge.UnitTests.Application.Flows;

internal sealed class FakeFlowStore : IFlowStore
{
    private readonly Lock _gate = new();
    private List<Flow> _flows = [];

    public bool Unreadable { get; set; }

    /// <summary>Run once a write has landed: a client that goes away at that moment, say.</summary>
    public Action? AfterWrite { get; set; }

    public IReadOnlyList<Flow> Flows
    {
        get { lock (_gate) return [.. _flows]; }
        set { lock (_gate) _flows = [.. value]; }
    }

    // Every call gives up on a token already cancelled, as JsonFlowStore's gate does.
    public Task<FlowDocument> LoadAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        return Task.FromResult(Unreadable ? new FlowDocument([], true) : new FlowDocument(Flows, false));
    }

    public Task SaveAsync(Flow flow, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        lock (_gate)
        {
            var at = _flows.FindIndex(one => one.Id == flow.Id);
            if (at >= 0) _flows[at] = flow;
            else _flows.Add(flow);
        }

        AfterWrite?.Invoke();
        return Task.CompletedTask;
    }

    public Task<bool> RemoveAsync(string id, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        bool removed;
        lock (_gate) removed = _flows.RemoveAll(one => one.Id == id) > 0;

        if (removed) AfterWrite?.Invoke();
        return Task.FromResult(removed);
    }
}

internal sealed class RecordingPublisher : IMqttPublisher
{
    private readonly Lock _gate = new();
    private readonly List<PublishRequest> _sent = [];

    private bool _stall;
    private int _held;

    public Exception? Fault { get; set; }

    /// <summary>
    /// When set, every publish waits on its token, and fails the way MQTTnet 5 does when that
    /// token is cancelled: with its own timeout exception, never with a cancellation.
    /// </summary>
    // A broker that has stopped answering, which is what the publish loop's deadline is for. The
    // exception is the point as much as the wait: MQTTnet's MqttPacketAwaitable turns a cancelled
    // wait into MqttCommunicationTimedOutException, so the loop cannot tell a timeout by its type.
    public bool Stall
    {
        get => Volatile.Read(ref _stall);
        set => Volatile.Write(ref _stall, value);
    }

    /// <summary>How many publishes are waiting on a stalled broker right now.</summary>
    public int Held => Volatile.Read(ref _held);

    public IReadOnlyList<PublishRequest> Sent
    {
        get { lock (_gate) return [.. _sent]; }
    }

    public Task PublishAsync(PublishRequest request, CancellationToken ct)
    {
        if (Fault is { } fault) return Task.FromException(fault);
        if (Stall) return StallAsync(ct);

        lock (_gate) _sent.Add(request);
        return Task.CompletedTask;
    }

    private async Task StallAsync(CancellationToken ct)
    {
        // MQTTnet's Request does this first, so a token that is already cancelled — the engine
        // shutting down with publishes still queued — is answered as a cancellation.
        ct.ThrowIfCancellationRequested();

        Interlocked.Increment(ref _held);
        try
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, ct);
        }
        catch (OperationCanceledException)
        {
            throw new TimeoutException("The operation has timed out.");
        }
        finally
        {
            Interlocked.Decrement(ref _held);
        }
    }
}

internal sealed class RecordingFlowNotifier : IFlowNotifier
{
    private readonly Lock _gate = new();
    private readonly List<FlowStatus> _statuses = [];
    private readonly List<FlowDebugEntry> _debug = [];
    private readonly List<string> _told = [];
    private readonly List<string> _alarmIds = [];
    private readonly Dictionary<string, string> _letters = new(StringComparer.Ordinal);
    private readonly List<int> _upWhenTold = [];

    private Exception? _fault;
    private int _failed;
    private int _linesDropped;
    private int _answered;
    private int _held;
    private TaskCompletionSource? _stuck;
    private FlowEngine? _engine;

    /// <summary>The engine to read when a raise is told. Set once it has been built.</summary>
    public FlowEngine? Engine
    {
        get => Volatile.Read(ref _engine);
        set => Volatile.Write(ref _engine, value);
    }

    /// <summary>When set, every status push throws it.</summary>
    public Exception? Fault
    {
        get => Volatile.Read(ref _fault);
        set => Volatile.Write(ref _fault, value);
    }

    /// <summary>How many status pushes threw.</summary>
    public int Failed => Volatile.Read(ref _failed);

    /// <summary>How many status pushes this console has answered, taken or thrown. Counted once it has.</summary>
    public int Answered => Volatile.Read(ref _answered);

    /// <summary>
    /// When set, every send — a push or an alarm — waits until it is cleared, or until its token calls
    /// it off: a console that has stopped reading. What it is handed meanwhile is recorded only once it
    /// is let go.
    /// </summary>
    public bool Stall
    {
        set
        {
            lock (_gate)
            {
                if (value) _stuck ??= new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                else
                {
                    _stuck?.TrySetResult();
                    _stuck = null;
                }
            }
        }
    }

    /// <summary>How many sends are waiting on the stalled console right now.</summary>
    public int Held => Volatile.Read(ref _held);

    private async Task WaitAsync(CancellationToken ct)
    {
        Task? stuck;
        lock (_gate) stuck = _stuck?.Task;
        if (stuck is null) return;

        Interlocked.Increment(ref _held);
        try
        {
            await stuck.WaitAsync(ct);
        }
        finally
        {
            Interlocked.Decrement(ref _held);
        }
    }

    public IReadOnlyList<FlowStatus> Statuses
    {
        get { lock (_gate) return [.. _statuses]; }
    }

    public IReadOnlyList<FlowDebugEntry> Debug
    {
        get { lock (_gate) return [.. _debug]; }
    }

    /// <summary>Every debug line the engine said it had to drop, added up.</summary>
    public int LinesDropped
    {
        get { lock (_gate) return _linesDropped; }
    }

    /// <summary>Every alarm the console was told of, one line each in the order told — "raised a", "resolved a".</summary>
    // Lettered by id in the order first seen, AlarmCallLog's way and for its reason.
    public IReadOnlyList<string> Alarms
    {
        get { lock (_gate) return [.. _told.Where(line => !line.StartsWith("status", StringComparison.Ordinal))]; }
    }

    /// <summary>The ids of the alarms the console was told of, in the order told.</summary>
    public IReadOnlyList<string> AlarmIds
    {
        get { lock (_gate) return [.. _alarmIds]; }
    }

    /// <summary>
    /// The alarms and the statuses in the order the console took them, a status as "status N" with N
    /// the alarms it shows standing.
    /// </summary>
    public IReadOnlyList<string> Told
    {
        get { lock (_gate) return [.. _told]; }
    }

    /// <summary>How many flow alarms the engine was showing at each moment the console was told of a raise.</summary>
    public IReadOnlyList<int> UpWhenTold
    {
        get { lock (_gate) return [.. _upWhenTold]; }
    }

    public Task StatusAsync(FlowStatus status, CancellationToken ct)
    {
        if (Fault is { } fault)
        {
            Interlocked.Increment(ref _failed);
            Interlocked.Increment(ref _answered);
            return Task.FromException(fault);
        }

        return RecordAsync(status, ct);
    }

    private async Task RecordAsync(FlowStatus status, CancellationToken ct)
    {
        await WaitAsync(ct);

        lock (_gate)
        {
            _statuses.Add(status);
            _told.Add($"status {status.Flows.Sum(flow => flow.Nodes.Sum(node => node.Standing.Count))}");
        }

        Interlocked.Increment(ref _answered);
    }

    public async Task DebugAsync(IReadOnlyList<FlowDebugEntry> entries, int dropped, CancellationToken ct)
    {
        await WaitAsync(ct);

        lock (_gate)
        {
            _debug.AddRange(entries);
            _linesDropped += dropped;
        }
    }

    public Task RaisedAsync(IReadOnlyList<Alert> alerts, CancellationToken ct)
    {
        // Read as the console is told, before it takes the frame: what it would find if it answered by
        // reading GET /api/alerts at once.
        var up = Engine?.Alarms.Active.Count ?? -1;

        lock (_gate) _upWhenTold.Add(up);

        return RecordAsync("raised", alerts, ct);
    }

    public Task ResolvedAsync(IReadOnlyList<Alert> alerts, CancellationToken ct) => RecordAsync("resolved", alerts, ct);

    private async Task RecordAsync(string kind, IReadOnlyList<Alert> alerts, CancellationToken ct)
    {
        await WaitAsync(ct);

        lock (_gate)
            foreach (var alert in alerts)
            {
                if (!_letters.TryGetValue(alert.Id, out var letter))
                    _letters[alert.Id] = letter = Letter(_letters.Count);

                _told.Add($"{kind} {letter}");
                _alarmIds.Add(alert.Id);
            }
    }

    // a to z, then aa, ab and on: a test that tells a few thousand alarms still reads them apart.
    private static string Letter(int n) => n < 26 ? ((char)('a' + n)).ToString() : Letter(n / 26 - 1) + (char)('a' + n % 26);
}

/// <summary>
/// Both alarm channels in one list, in the order the engine used them — call by call, and alarm by
/// alarm — and how many flow alarms the engine was showing at each moment it told the console of a raise.
/// </summary>
// One object for the notifier and the dispatcher because the question is about order across the
// two of them, which two separate recorders cannot answer.
internal sealed class AlarmCallLog : IAlertNotifier, IAlertDispatcher
{
    private readonly Lock _gate = new();
    private readonly List<string> _calls = [];
    private readonly List<string> _alarms = [];
    private readonly Dictionary<string, string> _letters = new(StringComparer.Ordinal);
    private readonly List<int> _upWhenTold = [];

    private FlowEngine? _engine;

    /// <summary>The engine to read when a raise is told. Set once it has been built.</summary>
    public FlowEngine? Engine
    {
        get => Volatile.Read(ref _engine);
        set => Volatile.Write(ref _engine, value);
    }

    /// <summary>When set, every call to the notifier half is recorded and then throws it.</summary>
    public Exception? NotifierFault { get; init; }

    /// <summary>When set, every call to the dispatcher half is recorded and then throws it.</summary>
    public Exception? DispatcherFault { get; init; }

    public IReadOnlyList<string> Calls
    {
        get { lock (_gate) return [.. _calls]; }
    }

    /// <summary>
    /// Every alarm either half was handed, one line each in the order handed — "told raised a",
    /// "sent resolved a" — with each alarm lettered in the order it was first seen.
    /// </summary>
    // Lettered by id, because two alarms of one node on one topic differ in nothing else a test can
    // read: the old broker's and the new one's, or the one a clear ended and the one raised next.
    public IReadOnlyList<string> Alarms
    {
        get { lock (_gate) return [.. _alarms]; }
    }

    public IReadOnlyList<int> UpWhenTold
    {
        get { lock (_gate) return [.. _upWhenTold]; }
    }

    Task IAlertNotifier.RaisedAsync(IReadOnlyList<Alert> alerts)
    {
        var up = Engine?.Alarms.Active.Count ?? -1;

        lock (_gate) _upWhenTold.Add(up);

        return Add("told raised", alerts, NotifierFault);
    }

    Task IAlertNotifier.ResolvedAsync(IReadOnlyList<Alert> alerts) => Add("told resolved", alerts, NotifierFault);

    Task IAlertNotifier.DroppedAsync(int total) => Task.CompletedTask;

    Task IAlertDispatcher.RaisedAsync(IReadOnlyList<Alert> alerts) => Add("sent raised", alerts, DispatcherFault);

    Task IAlertDispatcher.ResolvedAsync(IReadOnlyList<Alert> alerts) => Add("sent resolved", alerts, DispatcherFault);

    private Task Add(string call, IReadOnlyList<Alert> alerts, Exception? fault)
    {
        lock (_gate)
        {
            _calls.Add(call);

            foreach (var alert in alerts)
            {
                if (!_letters.TryGetValue(alert.Id, out var letter))
                    _letters[alert.Id] = letter = ((char)('a' + _letters.Count)).ToString();

                _alarms.Add($"{call} {letter}");
            }
        }

        return fault is null ? Task.CompletedTask : Task.FromException(fault);
    }
}

/// <summary>A wall clock that can be set back, over a fake one whose timers keep their own time.</summary>
// FakeTimeProvider only ever moves forward. A real clock can be set back — NTP pulling in one that
// ran fast, a virtual machine restored — and what then goes back is the wall time alone: a delay is
// a duration, and the timers under Task.Delay go on counting it. So the time read here steps back
// and every timer is the fake's, fired by its Advance as before.
internal sealed class SteppingClock(FakeTimeProvider time) : TimeProvider
{
    private long _backTicks;

    public void StepBack(TimeSpan by) => Interlocked.Add(ref _backTicks, by.Ticks);

    public override DateTimeOffset GetUtcNow() => time.GetUtcNow() - TimeSpan.FromTicks(Interlocked.Read(ref _backTicks));

    public override TimeZoneInfo LocalTimeZone => time.LocalTimeZone;

    public override long TimestampFrequency => time.TimestampFrequency;

    public override long GetTimestamp() => time.GetTimestamp();

    public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period) =>
        time.CreateTimer(callback, state, dueTime, period);
}

/// <summary>
/// RecordingSubscriber and three things it cannot do: keep the QoS every filter was asked for at,
/// throw from its list of filters, and wait on a broker that does not answer.
/// </summary>
// A decorator here rather than a change to the alert engine's fake: that one is shared with every
// alert test, and both questions are only this file's.
internal sealed class SubscriberProbe(RecordingSubscriber inner) : IMqttSubscriber
{
    private readonly Lock _gate = new();
    private readonly List<SubscriptionRequest> _requests = [];

    private Exception? _filtersFault;
    private Action? _onSubscribe;
    private bool _stall;
    private int _held;

    public IReadOnlyList<SubscriptionRequest> Requests
    {
        get { lock (_gate) return [.. _requests]; }
    }

    /// <summary>When set, every SUBSCRIBE waits on its token: a broker that never answers.</summary>
    public bool Stall
    {
        get => Volatile.Read(ref _stall);
        set => Volatile.Write(ref _stall, value);
    }

    /// <summary>How many SUBSCRIBEs are waiting on a stalled broker right now.</summary>
    public int Held => Volatile.Read(ref _held);

    /// <summary>Run once, inside the next SUBSCRIBE: something a test needs to happen in the middle of a turn.</summary>
    public Action? OnSubscribe
    {
        get => Volatile.Read(ref _onSubscribe);
        set => Volatile.Write(ref _onSubscribe, value);
    }

    /// <summary>When set, reading the filters throws it: a fault no real subscriber is known to have.</summary>
    public Exception? FiltersFault
    {
        get => Volatile.Read(ref _filtersFault);
        set => Volatile.Write(ref _filtersFault, value);
    }

    public IReadOnlyCollection<string> ActiveFilters => inner.ActiveFilters;

    public IReadOnlyCollection<ActiveFilter> Filters => FiltersFault is { } fault ? throw fault : inner.Filters;

    public Task SubscribeAsync(IReadOnlyList<SubscriptionRequest> requests, CancellationToken ct,
                               SubscriptionOwner owner = SubscriptionOwner.Console)
    {
        lock (_gate) _requests.AddRange(requests);
        Interlocked.Exchange(ref _onSubscribe, null)?.Invoke();
        return Stall ? StallAsync(ct) : inner.SubscribeAsync(requests, ct, owner);
    }

    private async Task StallAsync(CancellationToken ct)
    {
        Interlocked.Increment(ref _held);
        try
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, ct);
        }
        finally
        {
            Interlocked.Decrement(ref _held);
        }
    }

    public Task UnsubscribeAsync(string topicFilter, CancellationToken ct,
                                 SubscriptionOwner owner = SubscriptionOwner.Console) =>
        inner.UnsubscribeAsync(topicFilter, ct, owner);
}
