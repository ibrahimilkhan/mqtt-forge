namespace MqttForge.Domain.Models;

/// <summary>
/// What the rules file held. Unreadable is NOT the same as empty: see the spec's
/// "Kural dosyası bir kayıttır" decision.
/// </summary>
// JsonColourRuleStore reads a corrupt file as no rules, and it is right to — colours are a
// preference. Rules are not. Reading a corrupt rules file as 'no rules' turns every alert off
// without saying anything, and then the next save writes the emptiness down for good.
//
// SkippedIds is the same argument one rule at a time: a file that loads except for a single
// condition type this build has never heard of has to name what it dropped, because a save that
// silently omits the rules it did not understand has deleted them.
public sealed record AlertRuleDocument(
    IReadOnlyList<AlertRule> Rules,
    bool Unreadable,
    IReadOnlyList<string> SkippedIds);
