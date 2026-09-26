using MqttForge.Application.Flows;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;

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

        return Task.CompletedTask;
    }

    Task IAlertNotifier.ResolvedAsync(IReadOnlyList<Alert> alerts) => Add("told resolved");

    Task IAlertNotifier.DroppedAsync(int total) => Task.CompletedTask;

    Task IAlertDispatcher.RaisedAsync(IReadOnlyList<Alert> alerts) => Add("sent raised");

    Task IAlertDispatcher.ResolvedAsync(IReadOnlyList<Alert> alerts) => Add("sent resolved");

    private Task Add(string call)
    {
        lock (_gate) _calls.Add(call);
        return Task.CompletedTask;
    }
}
