using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;
using MqttForge.Application.Alerts;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Alerts;

// Hand-written fakes rather than NSubstitute, and that is not a preference here. Every one of
// these is touched by the pump's own thread while the test thread reads it, and a substitute's
// received-call list is not written to be read from two threads at once — a test that races it
// fails at random and blames the engine. These lock, and their readers hand back copies.
//
// They live in their own file because task 4's AlertRuleService tests need exactly the same six,
// and a second copy of a fake is a second thing to keep true.

/// <summary>
/// Stands in for MqttnetSubscriber, including its ownership arithmetic: a filter both owners hold
/// only leaves when the last of them lets go.
/// </summary>
internal sealed class RecordingSubscriber : IMqttSubscriber
{
    private readonly Lock _gate = new();
    private readonly List<ActiveFilter> _filters = [];
    private readonly List<IReadOnlyList<string>> _batches = [];
    private readonly List<string> _unsubscribed = [];

    private Exception? _refuse;

    /// <summary>When set, every SubscribeAsync throws it — the broker turning a filter down.</summary>
    // The attempt is still recorded, because the real one sends the packet before it learns the
    // answer, and a test about retrying has to be able to count the tries.
    public Exception? Refuse
    {
        get => Volatile.Read(ref _refuse);
        set => Volatile.Write(ref _refuse, value);
    }

    public IReadOnlyCollection<string> ActiveFilters
    {
        get { lock (_gate) return [.. _filters.Select(filter => filter.Filter)]; }
    }

    public IReadOnlyCollection<ActiveFilter> Filters
    {
        get { lock (_gate) return [.. _filters]; }
    }

    /// <summary>One entry per SubscribeAsync call, holding the filters that call carried.</summary>
    public IReadOnlyList<IReadOnlyList<string>> Batches
    {
        get { lock (_gate) return [.. _batches]; }
    }

    public IReadOnlyList<string> Unsubscribed
    {
        get { lock (_gate) return [.. _unsubscribed]; }
    }

    public Task SubscribeAsync(IReadOnlyList<SubscriptionRequest> requests, CancellationToken ct,
                               SubscriptionOwner owner = SubscriptionOwner.Console)
    {
        lock (_gate)
        {
            _batches.Add([.. requests.Select(request => request.TopicFilter)]);

            if (Refuse is { } refusal) return Task.FromException(refusal);

            foreach (var request in requests)
            {
                // Branched with a statement rather than folded into one conditional expression.
                // The obvious-looking `_filters[index] = index >= 0 ? … : _filters[index]` reads
                // the indexer on the failing side too, so the ordinary case — a filter going up
                // for the very first time, index -1 — throws ArgumentOutOfRangeException before
                // the conditional is ever consulted. Which is every subscribing test in the plan.
                var index = _filters.FindIndex(filter =>
                    string.Equals(filter.Filter, request.TopicFilter, StringComparison.Ordinal));

                if (index >= 0)
                    _filters[index] = _filters[index] with { Owners = _filters[index].Owners | owner };
                else
                    _filters.Add(new ActiveFilter(request.TopicFilter, owner, DateTimeOffset.UnixEpoch));
            }
        }

        return Task.CompletedTask;
    }

    public Task UnsubscribeAsync(string topicFilter, CancellationToken ct,
                                 SubscriptionOwner owner = SubscriptionOwner.Console)
    {
        lock (_gate)
        {
            _unsubscribed.Add(topicFilter);

            var index = _filters.FindIndex(filter =>
                string.Equals(filter.Filter, topicFilter, StringComparison.Ordinal));

            if (index >= 0)
            {
                var left = _filters[index].Owners & ~owner;

                if (left == SubscriptionOwner.None) _filters.RemoveAt(index);
                else _filters[index] = _filters[index] with { Owners = left };
            }
        }

        return Task.CompletedTask;
    }

    /// <summary>
    /// What MqttnetSubscriber.OnDisconnectedAsync does: subscriptions die with the connection and
    /// nothing tells the engine.
    /// </summary>
    public void LinkDropped()
    {
        lock (_gate) _filters.Clear();
    }
}

internal sealed class RecordingAlertNotifier : IAlertNotifier
{
    private readonly Lock _gate = new();
    private readonly List<Alert> _raised = [];
    private readonly List<Alert> _resolved = [];

    private bool _throw;
    private int _dropped;
    private int _dropCalls;

    /// <summary>When set, every call throws before recording anything.</summary>
    public bool Throw
    {
        get => Volatile.Read(ref _throw);
        set => Volatile.Write(ref _throw, value);
    }

    public IReadOnlyList<Alert> Raised
    {
        get { lock (_gate) return [.. _raised]; }
    }

    public IReadOnlyList<Alert> Resolved
    {
        get { lock (_gate) return [.. _resolved]; }
    }

    /// <summary>The last running total the engine handed on.</summary>
    public int Dropped => Volatile.Read(ref _dropped);

    /// <summary>How many times it bothered to say so.</summary>
    public int DropCalls => Volatile.Read(ref _dropCalls);

    public Task RaisedAsync(IReadOnlyList<Alert> alerts)
    {
        if (Throw) throw new InvalidOperationException("This notifier is broken.");

        lock (_gate) _raised.AddRange(alerts);

        return Task.CompletedTask;
    }

    public Task ResolvedAsync(IReadOnlyList<Alert> alerts)
    {
        if (Throw) throw new InvalidOperationException("This notifier is broken.");

        lock (_gate) _resolved.AddRange(alerts);

        return Task.CompletedTask;
    }

    public Task DroppedAsync(int total)
    {
        if (Throw) throw new InvalidOperationException("This notifier is broken.");

        Volatile.Write(ref _dropped, total);
        Interlocked.Increment(ref _dropCalls);

        return Task.CompletedTask;
    }
}

internal sealed class FakeAlertRuleStore : IAlertRuleStore
{
    private readonly Lock _gate = new();
    private readonly List<IReadOnlyList<AlertRule>> _saves = [];
    private AlertRuleDocument _document = new([], Unreadable: false, []);
    private int _loads;

    /// <summary>What the file currently says. A save replaces it, as a real file would.</summary>
    public AlertRuleDocument Document
    {
        get { lock (_gate) return _document; }
        set { lock (_gate) _document = value; }
    }

    public Exception? LoadFault { get; set; }

    public Exception? SaveFault { get; set; }

    public IReadOnlyList<IReadOnlyList<AlertRule>> Saves
    {
        get { lock (_gate) return [.. _saves]; }
    }

    public int Loads => Volatile.Read(ref _loads);

    public Task<AlertRuleDocument> LoadAsync(CancellationToken ct)
    {
        Interlocked.Increment(ref _loads);

        return LoadFault is { } fault
            ? Task.FromException<AlertRuleDocument>(fault)
            : Task.FromResult(Document);
    }

    public Task SaveAsync(IReadOnlyList<AlertRule> rules, CancellationToken ct)
    {
        if (SaveFault is { } fault) return Task.FromException(fault);

        lock (_gate)
        {
            _saves.Add(rules);
            _document = new AlertRuleDocument(rules, Unreadable: false, []);
        }

        return Task.CompletedTask;
    }
}

internal sealed class FakeAlertStateStore : IAlertStateStore
{
    private readonly Lock _gate = new();
    private readonly List<AlertState> _saves = [];

    /// <summary>What the hand-over file holds. Null is the ordinary first run.</summary>
    public AlertState? Stored { get; set; }

    public Exception? LoadFault { get; set; }

    public Exception? SaveFault { get; set; }

    public IReadOnlyList<AlertState> Saves
    {
        get { lock (_gate) return [.. _saves]; }
    }

    public Task<AlertState?> LoadAsync(CancellationToken ct) =>
        LoadFault is { } fault ? Task.FromException<AlertState?>(fault) : Task.FromResult(Stored);

    public Task SaveAsync(AlertState state, CancellationToken ct)
    {
        if (SaveFault is { } fault) return Task.FromException(fault);

        lock (_gate) _saves.Add(state);

        return Task.CompletedTask;
    }
}

internal sealed class FakeConnection : IMqttConnectionManager
{
    private int _state = (int)ConnectionState.Disconnected;

    // Settable, because the tests flip it from their own thread while the pump reads it from its
    // own — which is the entire point of the engine polling the state rather than being told.
    public ConnectionState State
    {
        get => (ConnectionState)Volatile.Read(ref _state);
        set => Volatile.Write(ref _state, (int)value);
    }

    public BrokerFailure? Failure => null;

    public BrokerLink? Link => null;

    public Task ConnectAsync(BrokerConnectionSettings settings, CancellationToken ct) => Task.CompletedTask;

    public Task DisconnectAsync(CancellationToken ct) => Task.CompletedTask;
}

internal sealed class RecordingLogger<T> : ILogger<T>
{
    private readonly Lock _gate = new();
    private readonly List<(LogLevel Level, string Message)> _lines = [];

    public IReadOnlyList<(LogLevel Level, string Message)> Lines
    {
        get { lock (_gate) return [.. _lines]; }
    }

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
                            Func<TState, Exception?, string> formatter)
    {
        lock (_gate) _lines.Add((logLevel, formatter(state, exception)));
    }
}

internal static class Eventually
{
    // Long enough that a loaded build machine does not fail a green test, short enough that a
    // genuinely stuck pump is a failed test rather than a hung run.
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    /// <summary>
    /// Waits for the engine to reach a state, moving its clock a second at a time while it waits.
    /// </summary>
    // Both halves are needed. The real delay lets the pump's own thread get on with a turn; the
    // fake advance is what makes a tick due, because FakeTimeProvider's timers only fire when the
    // clock is pushed. The condition is asked first, so a test whose work needs no time at all —
    // a posted command — settles without the clock moving.
    //
    // Advancing on every poll is deliberate: a timer created after an advance is due at the new
    // now, so a single advance can be missed by a pump that had not reached its wait yet. Asking
    // again a moment later is the only way that is not a sleep with a guess in it.
    public static async Task Until(FakeTimeProvider time, Func<bool> settled, string what)
    {
        var deadline = DateTime.UtcNow + Patience;

        while (DateTime.UtcNow < deadline)
        {
            if (settled()) return;

            time.Advance(TimeSpan.FromSeconds(1));
            await Task.Delay(5);
        }

        Assert.Fail($"Timed out waiting until {what}.");
    }
}

/// <summary>
/// Stands where the webhook and the MQTT dispatchers will stand, and keeps what it was given.
/// </summary>
// Beside RecordingAlertNotifier and locked the same way, for the same reason: the pump's thread
// writes these lists while the test thread reads them, and a fake that did not lock would fail at
// random and blame the engine.
internal sealed class RecordingAlertDispatcher : IAlertDispatcher
{
    private readonly Lock _gate = new();
    private readonly List<Alert> _raised = [];
    private readonly List<Alert> _resolved = [];

    private bool _throw;

    /// <summary>When set, every call throws before recording anything.</summary>
    public bool Throw
    {
        get => Volatile.Read(ref _throw);
        set => Volatile.Write(ref _throw, value);
    }

    public IReadOnlyList<Alert> Raised
    {
        get { lock (_gate) return [.. _raised]; }
    }

    public IReadOnlyList<Alert> Resolved
    {
        get { lock (_gate) return [.. _resolved]; }
    }

    public Task RaisedAsync(IReadOnlyList<Alert> alerts)
    {
        if (Throw) throw new InvalidOperationException("This dispatcher is broken.");

        lock (_gate) _raised.AddRange(alerts);

        return Task.CompletedTask;
    }

    public Task ResolvedAsync(IReadOnlyList<Alert> alerts)
    {
        if (Throw) throw new InvalidOperationException("This dispatcher is broken.");

        lock (_gate) _resolved.AddRange(alerts);

        return Task.CompletedTask;
    }
}
