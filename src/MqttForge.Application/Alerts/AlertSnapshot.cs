using MqttForge.Domain.Models;

namespace MqttForge.Application.Alerts;

public sealed record AlertSnapshot(
    IReadOnlyList<Alert> Active,
    IReadOnlyList<Alert> History,
    IReadOnlyList<MutedPair> Muted,
    IReadOnlyList<RuleDiagnostic> Rules,
    int Dropped,
    int Suppressed,
    IReadOnlyList<CappedRule> Capped,
    IReadOnlyList<WarmingPair> Warming);

// Muting addresses the pair, because that is what an alarm belongs to. An id resolved back to a
// pair would be a step that can disagree with itself, and a topic carries '/' so it cannot go in
// a path anyway.
public sealed record MutedPair(string RuleId, string Topic, DateTimeOffset Until);

// A quiet alert rule is not good news, and today an enabled rule that has never seen a message
// looks exactly like an enabled rule with nothing to report. These are the numbers that tell
// them apart: how many topics it found, how much it judged, and how much it had to pass over.
public sealed record RuleDiagnostic(
    string RuleId,
    int Topics,
    long Evaluated,
    long Skipped,
    DateTimeOffset? LastFiredAt,
    bool Faulted,
    string? FaultReason);

// A rule at a ceiling keeps working on what it already tracks and counts what it had to leave
// out. Stopping the rule outright would answer a memory question by turning off an alarm.
public sealed record CappedRule(string RuleId, int Untracked);

// A statistical rule says nothing for its first twenty readings on a topic, and that silence is
// the one failure this panel exists to explain: a rule that has been saved, matches, is receiving
// messages and is correctly quiet looks exactly like a rule that is broken.
//
// A row per pair rather than a flag on the rule, because a rule matching two hundred topics is
// warm on a hundred and ninety-eight of them and 'this rule is warming up' would be false about
// almost all of it. Have and Need rather than a percentage: seven of twenty is a number somebody
// can watch move, and eventually stop watching.
public sealed record WarmingPair(string RuleId, string Topic, int Have, int Need);
