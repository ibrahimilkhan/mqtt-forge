using MqttForge.Domain.Models;

namespace MqttForge.Domain.Abstractions;

/// <summary>Where the flows are kept between runs.</summary>
// Per flow rather than a whole document, unlike IAlertRuleStore. Two consoles editing two
// different flows is the ordinary case — the QR panel exists to put a second console on a phone —
// and a whole-document write lets the second save delete the first one's flow without either
// person touching it.
public interface IFlowStore
{
    Task<FlowDocument> LoadAsync(CancellationToken ct);

    /// <summary>Adds the flow, or replaces the one with its id, keeping its place in the file.</summary>
    /// <exception cref="Exceptions.FlowsUnreadableException">The file holds something unreadable.</exception>
    /// <exception cref="Exceptions.FlowsNotSavedException">The file could not be written.</exception>
    Task SaveAsync(Flow flow, CancellationToken ct);

    /// <summary>Takes the flow out. False when no flow had that id.</summary>
    Task<bool> RemoveAsync(string id, CancellationToken ct);
}
