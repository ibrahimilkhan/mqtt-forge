using MqttForge.Application.Alerts;

namespace MqttForge.Api;

/// <summary>Runs the engine's pump for the life of the process, and hands its state on when the
/// process ends.</summary>
// The engine is transport and the core is state, and neither of them is a hosted service: the
// pump has to start after the container is built and stop before it is torn down, which is what
// this class is for and all it is for.
//
// Every path through ExecuteAsync is caught. AddHostedService leaves
// BackgroundServiceExceptionBehavior at its default, StopHost, so an exception escaping here ends
// the application — and the spec names that trap by name when it explains why the engine wraps
// every rule's evaluation in its own try/catch. An alert engine that fell over must leave the
// console running; it is a monitoring tool, and the monitor going quiet is not a reason to take
// the log with it.
public sealed class AlertEngineHost : BackgroundService
{
    private readonly AlertEngine _engine;
    private readonly AlertEngineCore _core;
    private readonly IAlertStateStore _state;
    private readonly ILogger<AlertEngineHost> _log;

    // Whether this process ever took ownership of the state file, and whether it still holds it:
    // 1 until the hand-over below has captured it, 0 after. An int and not a bool, because
    // WebApplicationFactory is documented to call StopAsync more than once on the same instance on
    // the way out (dotnet/aspnetcore #40271, #50622) — a plain bool would let two overlapping calls
    // both read it true before either set it false, and both would then save.
    private int _owns;

    // The one hand-over, shared by every call to StopAsync rather than done again by each one.
    // Whichever call reaches StopAsync first creates it and does the work; every other call —
    // whether it arrives later or is running at the very same time, on WebApplicationFactory's
    // other stop chain — finds this already set and awaits it instead of starting a save of its
    // own or, worse, returning before the one save that is happening has actually finished. An
    // earlier version of this class only guarded *which* call saved (with the same Interlocked
    // idea, on _owns alone) and left the *other* call free to return at once — which is exactly
    // how a real end-to-end test still caught the state file being written after the test that
    // owned it had already deleted it and moved on: the call it awaited was not always the one
    // doing the saving.
    private TaskCompletionSource? _handover;

    public AlertEngineHost(
        AlertEngine engine, AlertEngineCore core, IAlertStateStore state, ILogger<AlertEngineHost> log)
    {
        _engine = engine;
        _core = core;
        _state = state;
        _log = log;
    }

    /// <summary>
    /// Loading the rules and the last state, before the loop and before the host is considered up.
    /// </summary>
    // Start-up work belongs in StartAsync, not in ExecuteAsync, and this is not a style point:
    // BackgroundService does not await ExecuteAsync, so anything done in there races the very
    // first StopAsync. A container told to stop a second after it started would cancel the token
    // mid-load, the load would throw OperationCanceledException, ownership would never be taken,
    // and the handover file would be left holding a previous process's alarms with nobody able to
    // say whether that was deliberate. Doing it here means that once StartAsync has returned, the
    // rules are in and the state is restored — full stop.
    //
    // A rules file that cannot be opened still does not stop the host: the engine catches that
    // itself and starts empty, deliberately, because a monitoring tool that refuses to start over
    // an unreadable file is a tool that is not monitoring.
    public override async Task StartAsync(CancellationToken cancellationToken)
    {
        // Rules and the last state, in that order, and both before a single message is judged: an
        // alert restored against a rule set that had not loaded yet would be reconciled against
        // nothing and resolve itself on the spot.
        await _engine.StartAsync(cancellationToken);
        Volatile.Write(ref _owns, 1);

        await base.StartAsync(cancellationToken);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await _engine.RunAsync(stoppingToken);
        }
        catch (OperationCanceledException)
        {
            // Shutdown. Whatever is still queued was never going to be judged in time anyway.
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "The alert engine stopped. No rules are being evaluated.");
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        // First, because this is what stops the pump and waits for it. AlertEngineCore has no
        // lock — the pump is the only thread that ever writes to it — so Capture below is safe
        // exactly once this has returned, and not a line earlier.
        await base.StopAsync(cancellationToken);

        // Whichever call gets here first — this is a race, not a queue, when WebApplicationFactory
        // is the caller — creates the one hand-over and does the work below; CompareExchange hands
        // every later or concurrent call back the same instance instead. Awaiting somebody else's
        // TaskCompletionSource rather than returning is the whole fix: a call that only checked
        // whether it was the one to save, and returned at once when it was not, could still return
        // before the call that *was* saving had finished — which is exactly the shape of the leak
        // this replaced.
        var mine = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var handover = Interlocked.CompareExchange(ref _handover, mine, null);

        if (handover is not null)
        {
            await handover.Task;
            return;
        }

        try
        {
            // A process that never took the state on must not be the one that writes it back. An
            // empty core saved over alert-state.json is every active alert deleted, and the ones
            // it would delete are exactly the ones a restart exists to hand over. Only the winner
            // of _handover above ever reaches this line, so nothing races this read any more — it
            // is still Interlocked rather than a plain read because that is what gives it the same
            // cross-thread visibility Volatile.Write gave the write in StartAsync.
            if (Interlocked.Exchange(ref _owns, 0) == 0) return;

            await _state.SaveAsync(_core.Capture(), cancellationToken);
        }
        catch (Exception ex)
        {
            // The one moment where a throw has nowhere useful to go. A full disk costs the
            // handover; it should not also cost a clean exit code.
            _log.LogError(ex, "Could not write the alert state on the way out.");
        }
        finally
        {
            // Set last, and unconditionally: every other call is awaiting exactly this, and a path
            // above that returned early — no ownership, or a caught exception — still has to let
            // them go rather than leave them waiting on a promise that is never kept.
            mine.SetResult();
        }
    }
}
