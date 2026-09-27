using MqttForge.Domain.Models;

namespace MqttForge.Application.Alerts;

/// <summary>Where the alert engine tells the console what its rules decided. The console's hub, in production.</summary>
// Beside IAlertNotifier and not folded into it, because of where each is called from. The notifier
// is told on the pump, so it has to be one that waits on nothing: the log. This is told from
// AlertConsoleSender's loop, which a console that has stopped reading can hold for as long as its
// connection lasts, and which holds up no rule while it does. The token is the engine stopping,
// and it calls off a send in flight.
//
// In Application rather than Domain, beside IFlowNotifier and for its reason: it is the engine's
// own seam, and the promise about who calls it is the engine's.
public interface IAlertConsole
{
    /// <summary>Alerts that went up: the badge, the sound and the notice.</summary>
    Task RaisedAsync(IReadOnlyList<Alert> alerts, CancellationToken ct);

    /// <summary>Alerts that came down.</summary>
    Task ResolvedAsync(IReadOnlyList<Alert> alerts, CancellationToken ct);

    /// <summary>The running total of messages the engine's queue had to discard.</summary>
    Task DroppedAsync(int total, CancellationToken ct);
}
