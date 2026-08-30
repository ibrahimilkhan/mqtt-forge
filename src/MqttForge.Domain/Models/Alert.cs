using MqttForge.Domain.Enums;

namespace MqttForge.Domain.Models;

/// <summary>
/// One (rule, topic) pair that is currently, or was recently, in the state its rule was written
/// to catch.
/// </summary>
// Not one alert per message. A topic sending fifty messages a second past a threshold produces
// one alert that keeps counting, not fifty alerts; Count and LastSeenAt are what a re-trigger
// touches while the alert is still active.
//
// Reason is the sentence a person reads — '94.2 > 90' — and its meaning never changes. Why an
// alert went away is ResolvedBy and deliberately not folded into Reason: an alert whose sentence
// rewrote itself on the way out would leave no record of what it had been complaining about.
//
// Actions travel with the alert because the console decides what to do with it. The hub says
// which channels a rule asked for, so a notice can be drawn without a tone and a tone can be
// played with the panel shut.
public sealed record Alert(
    string Id,
    string RuleId,
    string RuleName,
    string Topic,
    AlertSeverity Severity,
    DateTimeOffset FiredAt,
    DateTimeOffset LastSeenAt,
    DateTimeOffset? ResolvedAt,
    string? ResolvedBy,
    DateTimeOffset? MutedUntil,
    int Count,
    string Reason,
    double? Value,
    string? Sample,
    IReadOnlyList<AlertAction> Actions);
