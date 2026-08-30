using MqttForge.Domain.Models;

namespace MqttForge.Application.Alerts;

/// <summary>Everything that can reach the engine's queue, as one closed union.</summary>
// One channel and not four, because the ordering between them is the whole point: a mute posted
// after an arrival has to be applied after that arrival, and four queues would let the mute
// overtake the message it was about. The core is single-threaded by construction, so this union
// is also the entire list of ways any other thread is allowed to touch it.
public abstract record AlertCommand;

/// <summary>A message off the broker, on its way to be judged.</summary>
public sealed record ArrivalCommand(MqttMessage Message) : AlertCommand;

/// <summary>A save. The whole rule set, pushed rather than re-read.</summary>
public sealed record RuleSetChangedCommand(IReadOnlyList<AlertRule> Rules) : AlertCommand;

/// <summary>Silence one (rule, topic) pair. Zero minutes or fewer lifts an existing mute.</summary>
public sealed record MuteCommand(string RuleId, string Topic, int Minutes) : AlertCommand;

/// <summary>Empty the session's alert history.</summary>
public sealed record ClearHistoryCommand : AlertCommand;
