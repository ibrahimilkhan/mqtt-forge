using MqttForge.Domain.Exceptions;
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
        // As JsonFlowStore does: a file it cannot read is not written over.
        if (Unreadable) throw new FlowsUnreadableException("The flows file could not be read.");

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
    private readonly List<FlowSound> _sounds = [];
    private readonly List<FlowNotice> _notices = [];
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
    /// When set, every send — a push, an alarm, a tone or a notice — waits until it is cleared, or until
    /// its token calls it off: a console that has stopped reading. What it is handed meanwhile is recorded
    /// only once it is let go.
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
        get
        {
            lock (_gate)
                return [.. _told.Where(line => line.StartsWith("raised ", StringComparison.Ordinal) ||
                                               line.StartsWith("resolved ", StringComparison.Ordinal))];
        }
    }

    /// <summary>Every tone the console was told to play, in the order told.</summary>
    public IReadOnlyList<FlowSound> Sounds
    {
        get { lock (_gate) return [.. _sounds]; }
    }

    /// <summary>Every notice the console was told to show, in the order told.</summary>
    public IReadOnlyList<FlowNotice> Notices
    {
        get { lock (_gate) return [.. _notices]; }
    }

    /// <summary>The ids of the alarms the console was told of, in the order told.</summary>
    public IReadOnlyList<string> AlarmIds
    {
        get { lock (_gate) return [.. _alarmIds]; }
    }

    /// <summary>
    /// The alarms, the statuses, the tones and the notices in the order the console took them: a status
    /// as "status N" with N the alarms it shows standing, a batch of tones as "sounds" and of notices as
    /// "notices".
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
            _told.Add($"status {status.Runs.Sum(run => run.Nodes.Sum(node => node.Standing.Count))}");
        }

        Interlocked.Increment(ref _answered);
    }

    public async Task SoundsAsync(IReadOnlyList<FlowSound> sounds, CancellationToken ct)
    {
        await WaitAsync(ct);

        lock (_gate)
        {
            _sounds.AddRange(sounds);
            _told.Add("sounds");
        }
    }

    public async Task NoticesAsync(IReadOnlyList<FlowNotice> notices, CancellationToken ct)
    {
        await WaitAsync(ct);

        lock (_gate)
        {
            _notices.AddRange(notices);
            _told.Add("notices");
        }
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

/// <summary>A webhook channel that keeps what it is handed, takes it or refuses it, and fails it on demand.</summary>
internal sealed class RecordingFlowWebhook : IFlowWebhook
{
    private readonly Lock _gate = new();
    private readonly List<(FlowWebhookPost Post, Action<string> Failed)> _posts = [];

    /// <summary>When true, every post is refused as if the queue were full.</summary>
    public bool Full { get; set; }

    public IReadOnlyList<FlowWebhookPost> Posts
    {
        get { lock (_gate) return [.. _posts.Select(entry => entry.Post)]; }
    }

    public bool Post(FlowWebhookPost post, Action<string> failed)
    {
        if (Full) return false;

        lock (_gate) _posts.Add((post, failed));
        return true;
    }

    /// <summary>Gives up on the post at <paramref name="index"/>, as the channel would after its last attempt.</summary>
    public void Fail(int index, string reason)
    {
        Action<string> failed;
        lock (_gate) failed = _posts[index].Failed;
        failed(reason);
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

/// <summary>The fake clock, and the time every timer made on it is due: what the pump is waiting for.</summary>
// The pump reads the clock at the end of a turn, works out how long to wait, and only then makes the
// delay it waits on. A test that moves the clock on in between — because it saw what the turn did
// from another loop, a publish the publish loop has sent — moves it past a reading the pump already
// took: the delay is then made from the new time, falls due a whole wait late, and a test that holds
// the clock still waits for ever. So a test that means "when the pump next wakes" waits first for
// the delay to be made, due when it should be.
internal sealed class WatchedClock(FakeTimeProvider time) : TimeProvider
{
    private readonly Lock _gate = new();
    private readonly List<DateTimeOffset> _due = [];

    /// <summary>Whether a timer due at <paramref name="due"/> has been made.</summary>
    public bool Waits(DateTimeOffset due)
    {
        lock (_gate) return _due.Contains(due);
    }

    public override DateTimeOffset GetUtcNow() => time.GetUtcNow();

    public override TimeZoneInfo LocalTimeZone => time.LocalTimeZone;

    public override long TimestampFrequency => time.TimestampFrequency;

    public override long GetTimestamp() => time.GetTimestamp();

    // Recorded once the fake holds it, so a test that sees it can move the clock and have it fire.
    public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
    {
        var made = time.GetUtcNow();
        var timer = time.CreateTimer(callback, state, dueTime, period);

        lock (_gate) _due.Add(made + dueTime);
        return timer;
    }
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
