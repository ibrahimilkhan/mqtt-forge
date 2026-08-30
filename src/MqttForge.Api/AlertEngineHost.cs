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

    // Whether this process ever took ownership of the state file. Until it has, whatever is on
    // disk is newer than whatever the core holds, and the core holds nothing.
    private bool _owns;

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
        _owns = true;

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

        // A process that never took the state on must not be the one that writes it back. An
        // empty core saved over alert-state.json is every active alert deleted, and the ones it
        // would delete are exactly the ones a restart exists to hand over.
        if (!_owns) return;
        _owns = false;

        try
        {
            await _state.SaveAsync(_core.Capture(), cancellationToken);
        }
        catch (Exception ex)
        {
            // The one moment where a throw has nowhere useful to go. A full disk costs the
            // handover; it should not also cost a clean exit code.
            _log.LogError(ex, "Could not write the alert state on the way out.");
        }
    }
}
