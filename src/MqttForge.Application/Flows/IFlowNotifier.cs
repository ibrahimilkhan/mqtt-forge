using MqttForge.Domain.Models;

namespace MqttForge.Application.Flows;

/// <summary>Where the flow engine says what its flows are doing. The console's hub, in production.</summary>
// In Application rather than Domain, beside IAlertStateStore, because what it carries is Application's
// own shapes: Domain knows nothing about flows beyond how one is kept.
//
// Called from FlowConsoleSender's loop and never from the pump, so a console slow to take a send holds
// up that loop and no flow. The token is the engine stopping, and calls off a send in flight.
public interface IFlowNotifier
{
    /// <summary>Every run there is. Sent at most four times a second, and only when it moved.</summary>
    Task StatusAsync(FlowStatus status, CancellationToken ct);

    /// <summary>Lines for the debug strip, and how many were dropped since the last batch.</summary>
    Task DebugAsync(IReadOnlyList<FlowDebugEntry> entries, int dropped, CancellationToken ct);

    /// <summary>Flow alarms that went up, told as a rule's are: the badge and the alarm list.</summary>
    // Here and not only on IAlertNotifier, which has no token: the console's half of an alarm is sent
    // from the same loop as the pushes, and has to be called off with them.
    Task RaisedAsync(IReadOnlyList<Alert> alerts, CancellationToken ct);

    /// <summary>Flow alarms that came down.</summary>
    Task ResolvedAsync(IReadOnlyList<Alert> alerts, CancellationToken ct);

    /// <summary>Tones Sound nodes asked for, for every open console to play.</summary>
    Task SoundsAsync(IReadOnlyList<FlowSound> sounds, CancellationToken ct);

    /// <summary>Notices Notify nodes asked for, for every open console to show.</summary>
    Task NoticesAsync(IReadOnlyList<FlowNotice> notices, CancellationToken ct);
}
