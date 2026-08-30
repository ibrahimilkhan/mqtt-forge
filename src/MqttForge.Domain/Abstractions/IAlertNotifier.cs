using MqttForge.Domain.Models;

namespace MqttForge.Domain.Abstractions;

/// <summary>Where a turn of the engine says what it decided.</summary>
// Beside IMessageNotifier and for the same reason: the engine is not allowed to know whether
// anybody is listening. Plan 3 replaces the logging implementation with the SignalR one without
// this interface, the engine, or a single test of either of them changing.
//
// Raised and Resolved are separate calls rather than one call carrying an EngineOutcome, because
// every channel downstream treats them differently — a webhook sends a different body, the
// console plays a different sound — and a single method would make each of them unpack a record
// to find out which half it was given.
public interface IAlertNotifier
{
    Task RaisedAsync(IReadOnlyList<Alert> alerts);

    Task ResolvedAsync(IReadOnlyList<Alert> alerts);

    /// <summary>The running total of messages the engine's queue had to discard.</summary>
    // The total and not the increment, and only on a change: an engine that is keeping up says
    // nothing at all, which is what SignalRMessageNotifier's messagesDropped already does.
    Task DroppedAsync(int total);
}
