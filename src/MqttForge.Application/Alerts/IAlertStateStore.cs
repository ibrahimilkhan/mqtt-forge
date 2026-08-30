namespace MqttForge.Application.Alerts;

/// <summary>Where the alert state that must survive a restart is kept.</summary>
// In Application and not in Domain, where IAlertRuleStore and every other store abstraction
// lives, and the reason is the type it names: AlertState carries MutedPair, which AlertSnapshot
// already owns here, and moving that down to Domain to satisfy a habit would put a panel's row
// shape in the layer that is meant to hold the least. Infrastructure references Application, so
// the JSON implementation still sits beside every other store regardless.
public interface IAlertStateStore
{
    /// <summary>The state as it was last written, or null when there is nothing to restore.</summary>
    // Null rather than an empty AlertState, and the difference matters to the caller: an empty
    // state is a running engine with nothing ringing, and null is a file that was never written
    // or could not be understood. Only one of those is worth a line in the log.
    Task<AlertState?> LoadAsync(CancellationToken ct);

    Task SaveAsync(AlertState state, CancellationToken ct);
}
