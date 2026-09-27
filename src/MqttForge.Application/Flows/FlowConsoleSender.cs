using System.Threading.Channels;
using Microsoft.Extensions.Logging;

namespace MqttForge.Application.Flows;

/// <summary>What the pump has for the console, sent from a loop of its own: the pump hands it over and never waits.</summary>
// A console that stops reading holds a hub send for as long as its connection lasts — up to the
// client timeout — and a slow one paces every send at its bandwidth once the status is large.
// Awaited on the pump, either was every flow in the product waiting on one browser tab: no arrival
// judged, no alarm raised, no publish sent. So the pump only hands over, and this loop waits.
//
// What it holds is kept as what each thing is. A status is a whole picture and only the newest
// matters, so it is one slot the pump overwrites. Debug lines are a record, so they queue as the
// batches the pump made; the queue is bounded, and the lines of a batch it has to let go are added
// to the dropped count of the next one sent, so the strip's count of what it missed stays true.
//
// Alarms are a record too, and one the console acts on: an end it never hears leaves an alarm on
// the badge, and a raise it never hears is an alarm nobody sees. So they are kept in the order they
// happened, every one of them while no more than AlarmEvents are waiting, and are sent before any
// status that counts them — see SendWaitingAsync, and Compact for what happens past that bound,
// whether the console has stopped taking or one turn handed over more than it holds.
public sealed class FlowConsoleSender
{
    /// <summary>Debug batches kept for a console slow to take them: four seconds of the pump's pushes.</summary>
    public const int DebugBatches = 16;

    /// <summary>Alarm events kept for a console slow to take them before any are let go.</summary>
    // Four times what may stand at once, for Compact's reason: past it, the alarms that came and went
    // while the console was not taking go, and what is left is never more than twice what may stand.
    public const int AlarmEvents = 4 * FlowLimits.StandingAlarms;

    private readonly IFlowNotifier _console;
    private readonly ILogger _log;
    private readonly Channel<DebugBatch> _debug;

    // Rung whenever there is something to send, and read empty by the loop before it sends it all.
    // One ring is enough however many came, so a second one is simply not kept.
    private readonly Channel<bool> _bell = Channel.CreateBounded<bool>(
        new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.DropWrite, SingleReader = true });

    // A list under a lock rather than a channel: what Compact does needs the whole of it at once.
    private readonly Lock _gate = new();
    private List<FlowAlarmEvent> _alarms = [];

    // Alarms that came and went untold, and events let go past the bound, not yet said in the log.
    private int _untold;
    private int _alarmsLost;

    private FlowStatus? _status;

    // Lines in batches the queue let go, dropped counts and all, not yet told to the console.
    private int _lost;

    public FlowConsoleSender(IFlowNotifier console, ILogger log)
    {
        _console = console;
        _log = log;
        _debug = Channel.CreateBounded<DebugBatch>(
            new BoundedChannelOptions(DebugBatches) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true },
            batch => Interlocked.Add(ref _lost, batch.Entries.Count + batch.Dropped));
    }

    /// <summary>The newest picture, in place of any the console has not been sent yet. Never waits.</summary>
    public void Status(FlowStatus status)
    {
        Volatile.Write(ref _status, status);
        _bell.Writer.TryWrite(true);
    }

    /// <summary>A batch of lines, and how many the pump had to drop before it. Never waits.</summary>
    public void Debug(IReadOnlyList<FlowDebugEntry> entries, int dropped)
    {
        _debug.Writer.TryWrite(new DebugBatch(entries, dropped));
        _bell.Writer.TryWrite(true);
    }

    /// <summary>Alarms that went up and came down, in the order they did, after every one handed over before. Never waits.</summary>
    public void Alarms(IReadOnlyList<FlowAlarmEvent> alarms)
    {
        if (alarms.Count == 0) return;

        lock (_gate)
        {
            _alarms.AddRange(alarms);
            if (_alarms.Count > AlarmEvents) Compact();
        }

        _bell.Writer.TryWrite(true);
    }

    /// <summary>Nothing more is coming: the loop sends what it holds and ends.</summary>
    public void Complete() => _bell.Writer.TryComplete();

    /// <summary>The loop, until <paramref name="ct"/> ends it — which also calls off a send in flight.</summary>
    public async Task RunAsync(CancellationToken ct)
    {
        try
        {
            while (await _bell.Reader.WaitToReadAsync(ct))
            {
                _bell.Reader.TryRead(out _);
                await SendWaitingAsync(ct);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Shutdown. What was still waiting goes with the process, as it would have with the pump.
        }
    }

    // Until nothing is waiting: the alarms, a status and then a batch at a time, so a console taking a
    // backlog of lines is not kept on an old picture meanwhile.
    //
    // The status is taken before the alarms. Every alarm it counts was handed over before it, so is
    // among the alarms taken next and goes out ahead of it; an alarm handed over after it goes ahead of
    // it too, and a picture a push behind the badge is put right by the next push, a quarter second on.
    // Taken the other way round, a status could count an alarm handed over after the alarms were taken,
    // and light a node for an alarm the badge had not been told of.
    //
    // Within the bound, that is. Past it, Compact lets go both ends of an alarm that came and went
    // while waiting, and the status waiting beside them may have been made while that alarm stood:
    // it then counts an alarm the console is never told of, until the next push, a quarter second on.
    private async Task SendWaitingAsync(CancellationToken ct)
    {
        while (true)
        {
            var sent = false;
            var status = Interlocked.Exchange(ref _status, null);

            if (TakeAlarms() is { } alarms)
            {
                foreach (var (raised, alerts) in FlowAlarmEvent.Runs(alarms))
                    await SendAsync(() => raised ? _console.RaisedAsync(alerts, ct) : _console.ResolvedAsync(alerts, ct), ct);

                sent = true;
            }

            if (status is not null)
            {
                await SendAsync(() => _console.StatusAsync(status, ct), ct);
                sent = true;
            }

            var hasBatch = _debug.Reader.TryRead(out var batch);
            var lost = Interlocked.Exchange(ref _lost, 0);

            if (hasBatch || lost > 0)
            {
                await SendAsync(() => _console.DebugAsync(batch?.Entries ?? [], (batch?.Dropped ?? 0) + lost, ct), ct);
                sent = true;
            }

            if (!sent) return;
        }
    }

    private List<FlowAlarmEvent>? TakeAlarms()
    {
        List<FlowAlarmEvent> alarms;
        int untold, lost;

        lock (_gate)
        {
            if (_alarms.Count == 0) return null;

            alarms = _alarms;
            _alarms = [];
            (untold, _untold) = (_untold, 0);
            (lost, _alarmsLost) = (_alarmsLost, 0);
        }

        // Said once the console is taking again, rather than every time the list was cut back. The log
        // and not the alert history, which keeps the last hundred to end: past the bound these are
        // thousands, and most of them are gone from it by now.
        if (untold > 0)
            _log.LogWarning("{Count} flow alarms went up and came down while the console was not taking what it was sent. " +
                            "It was not told of them; the log was.", untold);

        if (lost > 0)
            _log.LogWarning("The console fell {Count} flow alarm events behind, and the oldest were let go. " +
                            "It shows the alarms as they stand the next time it reads them.", lost);

        return alarms;
    }

    /// <summary>What the console still needs of the alarms waiting for it, cut to that once there are too many.</summary>
    // An alarm that went up and came down while the console was not taking is let go, both ends of it:
    // a console never told it went up has nothing to take down, and what it missed is in the log. Every
    // other event stays, in its order. What is left is then at most the alarms standing now, whose
    // ends have not come, and the ends of those standing when the console stopped taking, whose
    // raises it has — twice FlowLimits.StandingAlarms, at any rate of alarms.
    //
    // Only past the bound: a console that never has more than AlarmEvents waiting is told of every
    // alarm, however briefly it stood. One that keeps up can still get here, when a single turn hands
    // over more than that at once. And the oldest go after all if that is still too many, which no
    // alarm book that keeps its ceiling can make happen, so that the bound holds whatever the pump
    // hands over.
    private void Compact()
    {
        var ended = new HashSet<string>(StringComparer.Ordinal);
        foreach (var alarm in _alarms)
            if (!alarm.Raised) ended.Add(alarm.Alert.Id);

        var cameAndWent = new HashSet<string>(StringComparer.Ordinal);
        foreach (var alarm in _alarms)
            if (alarm.Raised && ended.Contains(alarm.Alert.Id)) cameAndWent.Add(alarm.Alert.Id);

        if (cameAndWent.Count > 0)
        {
            _alarms.RemoveAll(alarm => cameAndWent.Contains(alarm.Alert.Id));
            _untold += cameAndWent.Count;
        }

        if (_alarms.Count <= AlarmEvents) return;

        var over = _alarms.Count - AlarmEvents;
        _alarms.RemoveRange(0, over);
        _alarmsLost += over;
    }

    // FlowEngine's rule for every channel: a cancellation is let through only when it is the engine
    // stopping. Anything else — a hub send that gave up, a console gone mid-frame — is this send's
    // failure alone, and the next push is a new picture anyway.
    private async Task SendAsync(Func<Task> send, CancellationToken ct)
    {
        try
        {
            await send();
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            _log.LogWarning(ex, "Could not tell the console what the flows are doing.");
        }
    }

    private sealed record DebugBatch(IReadOnlyList<FlowDebugEntry> Entries, int Dropped);
}
