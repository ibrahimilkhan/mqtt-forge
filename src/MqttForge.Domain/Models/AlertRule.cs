using MqttForge.Domain.Enums;

namespace MqttForge.Domain.Models;

/// <summary>
/// One thing the user wants to be told about: which topics to watch, what to ask of them, how
/// long the answer has to hold, and who to tell.
/// </summary>
// Filter is a subscription and not just a match: the engine owns it, subscribes it, and
// re-subscribes it on every reconnect. A rule whose filter nobody subscribed is a rule that never
// fires and never says why.
//
// Clear is a second condition rather than a hysteresis number bolted onto a threshold. A number
// has no meaning on a band — which edge, which direction — and none at all on a composite, while
// '> 80 fires, < 75 clears' is as easy to write and works with every condition type there is.
//
// For and Cooldown are nullable rather than zero-defaulted so that 'not set' and 'set to nothing'
// stay different things at this layer; the engine reads a null Cooldown as one second, which is
// the flapping defence the spec insists must be on by default.
public sealed record AlertRule(
    string Id,
    string Name,
    bool Enabled,
    string Filter,
    string? Field,
    AlertCondition Condition,
    AlertCondition? Clear,
    int? For,
    int? Cooldown,
    AlertSeverity Severity,
    IReadOnlyList<AlertAction> Actions);
