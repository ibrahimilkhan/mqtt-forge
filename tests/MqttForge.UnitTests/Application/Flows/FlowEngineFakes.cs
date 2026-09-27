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

    public IReadOnlyList<Flow> Flows
    {
        get { lock (_gate) return [.. _flows]; }
        set { lock (_gate) _flows = [.. value]; }
    }

    public Task<FlowDocument> LoadAsync(CancellationToken ct) =>
        Task.FromResult(Unreadable ? new FlowDocument([], true) : new FlowDocument(Flows, false));

    public Task SaveAsync(Flow flow, CancellationToken ct)
    {
        lock (_gate)
        {
            var at = _flows.FindIndex(one => one.Id == flow.Id);
            if (at >= 0) _flows[at] = flow;
            else _flows.Add(flow);
        }

        return Task.CompletedTask;
    }

    public Task<bool> RemoveAsync(string id, CancellationToken ct)
    {
        lock (_gate) return Task.FromResult(_flows.RemoveAll(one => one.Id == id) > 0);
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

    private Exception? _fault;
    private int _failed;
    private int _linesDropped;

    /// <summary>When set, every status push throws it.</summary>
    public Exception? Fault
    {
        get => Volatile.Read(ref _fault);
        set => Volatile.Write(ref _fault, value);
    }

    /// <summary>How many status pushes threw.</summary>
    public int Failed => Volatile.Read(ref _failed);

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

    public Task StatusAsync(FlowStatus status)
    {
        if (Fault is { } fault)
        {
            Interlocked.Increment(ref _failed);
            return Task.FromException(fault);
        }

        lock (_gate) _statuses.Add(status);
        return Task.CompletedTask;
    }

    public Task DebugAsync(IReadOnlyList<FlowDebugEntry> entries, int dropped)
    {
        lock (_gate)
        {
            _debug.AddRange(entries);
            _linesDropped += dropped;
        }

        return Task.CompletedTask;
    }
}

/// <summary>
/// Both alarm channels in one list, in the order the engine used them, and how many flow alarms
/// the engine was showing at each moment it told the console of a raise.
/// </summary>
// One object for the notifier and the dispatcher because the question is about order across the
// two of them, which two separate recorders cannot answer.
internal sealed class AlarmCallLog : IAlertNotifier, IAlertDispatcher
{
    private readonly Lock _gate = new();
    private readonly List<string> _calls = [];
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

    public IReadOnlyList<int> UpWhenTold
    {
        get { lock (_gate) return [.. _upWhenTold]; }
    }

    Task IAlertNotifier.RaisedAsync(IReadOnlyList<Alert> alerts)
    {
        var up = Engine?.Alarms.Active.Count ?? -1;

        lock (_gate)
        {
            _calls.Add("told raised");
            _upWhenTold.Add(up);
        }

        return NotifierFault is { } fault ? Task.FromException(fault) : Task.CompletedTask;
    }

    Task IAlertNotifier.ResolvedAsync(IReadOnlyList<Alert> alerts) => Add("told resolved", NotifierFault);

    Task IAlertNotifier.DroppedAsync(int total) => Task.CompletedTask;

    Task IAlertDispatcher.RaisedAsync(IReadOnlyList<Alert> alerts) => Add("sent raised", DispatcherFault);

    Task IAlertDispatcher.ResolvedAsync(IReadOnlyList<Alert> alerts) => Add("sent resolved", DispatcherFault);

    private Task Add(string call, Exception? fault)
    {
        lock (_gate) _calls.Add(call);
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
