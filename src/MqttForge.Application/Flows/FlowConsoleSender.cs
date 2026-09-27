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
public sealed class FlowConsoleSender
{
    /// <summary>Debug batches kept for a console slow to take them: four seconds of the pump's pushes.</summary>
    public const int DebugBatches = 16;

    private readonly IFlowNotifier _console;
    private readonly ILogger _log;
    private readonly Channel<DebugBatch> _debug;

    // Rung whenever there is something to send, and read empty by the loop before it sends it all.
    // One ring is enough however many came, so a second one is simply not kept.
    private readonly Channel<bool> _bell = Channel.CreateBounded<bool>(
        new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.DropWrite, SingleReader = true });

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

    // Until nothing is waiting, a status and then a batch at a time: a console taking a backlog of
    // lines is not kept on an old picture meanwhile.
    private async Task SendWaitingAsync(CancellationToken ct)
    {
        while (true)
        {
            var sent = false;

            if (Interlocked.Exchange(ref _status, null) is { } status)
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
