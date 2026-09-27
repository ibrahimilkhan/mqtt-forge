using MqttForge.Domain.Models;

namespace MqttForge.Application.Alerts;

// What one call into the core changed. Raised and Resolved are separate lists rather than one
// list of events because every channel downstream treats them differently: a webhook sends a
// different body, the console plays a different sound, and the retained record is written by one
// and cleared by the other.
//
// Two lists are enough for one call, and only for one: a call can raise a pair and then end it,
// never end it and raise it again, so telling its raises before its ends keeps every pair's own
// order. A turn of the engine makes many calls, and tells them as AlertEvents, call after call.
public sealed record EngineOutcome(IReadOnlyList<Alert> Raised, IReadOnlyList<Alert> Resolved)
{
    public static readonly EngineOutcome Empty = new([], []);
}
