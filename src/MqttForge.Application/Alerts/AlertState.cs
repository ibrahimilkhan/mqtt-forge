using MqttForge.Domain.Models;

namespace MqttForge.Application.Alerts;

/// <summary>
/// Only what a restart must not lose: the alarms that are still ringing, the pairs somebody
/// silenced, and the cooldowns that have not run out. Alert history is deliberately not here.
/// </summary>
// The distinction is between a record and an unfinished promise. History is a record, and this
// tool is not where records live — the endpoint the webhook posts to is. An active alert is a
// promise that has not been closed: the process died with an alarm ringing, Clear only runs on
// arrival and only while an alert is active, so without this file the resolved body is never
// sent and the endpoint holds that alarm for ever. Spec: "Yeniden başlatma alarm durumunu taşır".
//
// The trigger is not a user action. `restart: unless-stopped` on a container restarts this
// process as a matter of course, and every one of those restarts would otherwise leak an alarm.
public sealed record AlertState(
    IReadOnlyList<Alert> Active,
    IReadOnlyList<MutedPair> Muted,
    IReadOnlyList<CooldownEntry> Cooldowns,
    // What each of those rules hashed to at the moment the state was captured, and the reason
    // this is a fourth member rather than a fourth thing: the spec's three lists are what the
    // file is FOR, and this is how they are read back safely. ConfigHash.cs says so in its own
    // comment — "this value is written into alert-state.json and read back after a restart" —
    // because reconciliation has to answer "is this still the same rule?" and the rules file may
    // well have been edited by hand while the process was down.
    //
    // Appended last with a default, the way MqttMessage.Replay was, so that a hand-built state
    // in a test or a caller that has nothing to fingerprint still constructs with three lists.
    // Null and empty mean the same thing and both mean 'cannot be shown to be the same rule',
    // which AlertEngineCore.Restore reads as changed — see WhyDropped, which already takes that
    // position for exactly this case.
    IReadOnlyList<RuleFingerprint>? Fingerprints = null);

/// <summary>One pair that is still cooling down, and the moment it may ring again.</summary>
// A cooldown outlives the alert that set it — that is its whole job — so it cannot be carried on
// the alert and has to be its own row.
public sealed record CooldownEntry(string RuleId, string Topic, DateTimeOffset Until);

/// <summary>What one rule hashed to when the state was written.</summary>
public sealed record RuleFingerprint(string RuleId, string Hash);
