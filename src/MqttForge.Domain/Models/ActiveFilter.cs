using MqttForge.Domain.Enums;

namespace MqttForge.Domain.Models;

/// <summary>One filter the broker has granted: who holds it, and when the SUBACK arrived.</summary>
// GrantedAt is not bookkeeping. Every subscription makes the broker replay the retained last
// value of every topic it covers, and those replays have to be told apart from live traffic —
// see MqttMessage.Replay, which is computed from this moment and from nothing else.
public sealed record ActiveFilter(string Filter, SubscriptionOwner Owners, DateTimeOffset GrantedAt);
