using MqttForge.Domain.Models;

namespace MqttForge.Application.Alerts;

// What one turn of the engine changed. Raised and Resolved are separate lists rather than one
// list of events because every channel downstream treats them differently: a webhook sends a
// different body, the console plays a different sound, and the retained record is written by one
// and cleared by the other.
public sealed record EngineOutcome(IReadOnlyList<Alert> Raised, IReadOnlyList<Alert> Resolved)
{
    public static readonly EngineOutcome Empty = new([], []);
}
