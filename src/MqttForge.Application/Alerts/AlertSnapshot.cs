using MqttForge.Domain.Models;

namespace MqttForge.Application.Alerts;

// Everything the panel shows, as one immutable object. The pump writes it to a field after each
// change and GET /api/alerts only reads that field, so no reader ever takes a lock on state the
// message path is writing.
//
// Dropped is the one number the core cannot know: messages are dropped by the channel in front
// of it, and by the time a message is missing there is nothing here to notice. Task 13 gives the
// core a SetDropped so the transport can hand the running total in.
public sealed record AlertSnapshot(
    IReadOnlyList<Alert> Active,
    IReadOnlyList<Alert> History,
    IReadOnlyList<MutedPair> Muted,
    IReadOnlyList<RuleDiagnostic> Rules,
    int Dropped,
    int Suppressed,
    IReadOnlyList<CappedRule> Capped);

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
