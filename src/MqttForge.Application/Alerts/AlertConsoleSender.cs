using System.Threading.Channels;
using Microsoft.Extensions.Logging;

namespace MqttForge.Application.Alerts;

/// <summary>What the pump has for the console, sent from a loop of its own: the pump hands it over and never waits.</summary>
// FlowConsoleSender's shape, for the alert rules and for their reason. A console that stops reading
// holds a hub send for as long as its connection lasts — up to the client timeout — and SignalR
// writes one message at a time to a connection, so every frame after it waits as well. Awaited on
// the pump, that was every rule in the product waiting on one browser tab: no reading judged, no
// silence noticed, no alarm raised. So the pump only hands over, and this loop waits.
//
// What it holds is kept as what each thing is. The alerts are a record the console acts on — an
// end it never hears leaves an alarm on the badge — so they wait in their order, in a backlog with
// a bound. The drop total is a running number of which only the newest matters, so it is one slot
// the pump overwrites.
public sealed class AlertConsoleSender
{
    /// <summary>Alert events kept for a console slow to take them before any are let go.</summary>
    // Four times what may stand at once, for AlertBacklog's reason: past it, the alerts that came
    // and went while the console was not taking go, and what is left is never more than twice that.
    public static readonly int AlertEvents = 4 * new AlertEngineOptions().MaxActiveAlerts;

    private readonly IAlertConsole _console;
    private readonly ILogger _log;
    private readonly AlertBacklog _alerts = new(AlertEvents);

    // Rung whenever there is something to send, and read empty by the loop before it sends it all.
    // One ring is enough however many came, so a second one is simply not kept.
    private readonly Channel<bool> _bell = Channel.CreateBounded<bool>(
        new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.DropWrite, SingleReader = true });

    // The newest drop total not yet sent, or -1 when there is none.
    private int _dropped = -1;

    public AlertConsoleSender(IAlertConsole console, ILogger log)
    {
        _console = console;
        _log = log;
    }

    /// <summary>Alerts that went up and came down, in the order they did, after every one handed over before. Never waits.</summary>
    public void Alerts(IReadOnlyList<AlertEvent> events)
    {
        if (events.Count == 0) return;

        _alerts.Add(events);
        _bell.Writer.TryWrite(true);
    }

    /// <summary>The newest drop total, in place of any the console has not been sent yet. Never waits.</summary>
    public void Dropped(int total)
    {
        Volatile.Write(ref _dropped, total);
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

    // Until nothing is waiting: the alerts in runs of one kind, then the newest total.
    private async Task SendWaitingAsync(CancellationToken ct)
    {
        while (true)
        {
            var sent = false;

            if (_alerts.Take() is { } taken)
            {
                Say(taken);

                foreach (var (raised, alerts) in AlertEvent.Runs(taken.Events))
                    await SendAsync(() => raised ? _console.RaisedAsync(alerts, ct) : _console.ResolvedAsync(alerts, ct), ct);

                sent = true;
            }

            var dropped = Interlocked.Exchange(ref _dropped, -1);
            if (dropped >= 0)
            {
                await SendAsync(() => _console.DroppedAsync(dropped, ct), ct);
                sent = true;
            }

            if (!sent) return;
        }
    }

    // Said once the console is taking again, rather than every time the backlog was cut back.
    private void Say(AlertBacklog.Taken taken)
    {
        if (taken.Untold > 0)
            _log.LogWarning("{Count} alerts went up and came down while the console was not taking what it was sent. " +
                            "It was not told of them; the log was.", taken.Untold);

        if (taken.Lost > 0)
            _log.LogWarning("The console fell {Count} alert events behind, and the oldest were let go. " +
                            "It shows the alerts as they stand the next time it reads them.", taken.Lost);
    }

    // AlertEngine's rule for every channel: a cancellation is let through only when it is the engine
    // stopping. Anything else — a hub send that gave up, a console gone mid-frame — is this send's
    // failure alone.
    private async Task SendAsync(Func<Task> send, CancellationToken ct)
    {
        try
        {
            await send();
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            _log.LogWarning(ex, "Could not tell the console what the alert rules decided.");
        }
    }
}
