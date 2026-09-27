namespace MqttForge.Application.Flows;

/// <summary>Where the flow engine says what its flows are doing. The console's hub, in production.</summary>
// In Application rather than Domain, beside IAlertStateStore, because what it carries is an
// Application type: the status is the runtime's own shape, and Domain knows nothing about flows
// beyond how one is kept.
//
// Called from FlowConsoleSender's loop and never from the pump, so a console slow to take a send
// holds up that loop and no flow. The token is the engine stopping, and calls off a send in flight.
public interface IFlowNotifier
{
    /// <summary>What every running flow has done. Sent at most four times a second, and only when it moved.</summary>
    Task StatusAsync(FlowStatus status, CancellationToken ct);

    /// <summary>Lines for the debug strip, and how many were dropped since the last batch.</summary>
    Task DebugAsync(IReadOnlyList<FlowDebugEntry> entries, int dropped, CancellationToken ct);
}
