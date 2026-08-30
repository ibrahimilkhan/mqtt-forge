namespace MqttForge.Domain.Enums;

// How loud an alert is. Three levels rather than five: the console has to pick a tone and a
// notice behaviour from this, and a level nobody can tell apart from its neighbour by ear or by
// eye is a level that only makes the rule editor longer.
//
// The order is deliberate and load-bearing — the panel sorts active alerts by it, so Critical
// must sit last and nothing may be inserted in the middle later without moving these numbers.
public enum AlertSeverity
{
    Info,
    Warn,
    Critical
}
