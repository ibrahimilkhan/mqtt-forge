using System.Text;
using MqttForge.Application.Alerts;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.Api.Contracts;

/// <summary>
/// One alarm, as the panel and the hub see it. The record with its sample cut down and its
/// actions reduced to the words the console needs.
/// </summary>
// Actions travel as words rather than as the union because the console does not act on an action,
// it acts on a channel: draw a notice, play a tone. A webhook's URL and a publish action's topic
// are server business and have no reader in the browser — and one of them is an address the alarm
// list has no reason to broadcast to every connected tab.
public sealed record AlertDto(
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
    IReadOnlyList<string> Actions)
{
    /// <summary>
    /// How much of the body that fired the alarm the console is sent. The webhook and the MQTT
    /// publish carry 4 kB of it; this is the other of the spec's two sizes.
    /// </summary>
    // "Sample iki boydadır çünkü bin alarmlık bir listeyi 4MB'lık bir gövdeye çevirmenin karşılığı
    // yok." A history of a thousand rows is the shape this number is sized for, and it is sent
    // again on every reconnect.
    public const int SampleLimit = 256;

    public static AlertDto Of(Alert alert) =>
        new(alert.Id, alert.RuleId, alert.RuleName, alert.Topic, alert.Severity, alert.FiredAt,
            alert.LastSeenAt, alert.ResolvedAt, alert.ResolvedBy, alert.MutedUntil, alert.Count,
            alert.Reason, alert.Value, Clip(alert.Sample),
            [.. alert.Actions.Select(AlertActionDto.NameOf)]);

    /// <summary>The sample, cut to <see cref="SampleLimit"/> bytes without splitting a character.</summary>
    // Bytes, because that is what the limit is about — the frame — and characters, because that is
    // what the reader sees. A cut counted in bytes lands in the middle of one about a fifth of the
    // time on a payload with any non-ASCII in it, and half a rune reaches the panel as a
    // replacement character sitting in the one payload the reader most wants to look at.
    //
    // 10xxxxxx is a UTF-8 continuation byte; walking back off them lands on the first byte of the
    // character the cut fell inside, and dropping that character whole is the answer.
    public static string? Clip(string? sample)
    {
        if (sample is null) return null;

        var bytes = Encoding.UTF8.GetBytes(sample);
        if (bytes.Length <= SampleLimit) return sample;

        var cut = SampleLimit;
        while (cut > 0 && (bytes[cut] & 0xC0) == 0x80) cut--;

        return Encoding.UTF8.GetString(bytes, 0, cut);
    }
}

/// <summary>Everything GET /api/alerts answers, and everything the panel draws.</summary>
// The snapshot plus two numbers it cannot hold. WebhooksDropped is counted by a queue in
// Infrastructure that the core has never heard of, and BlindSeconds is the link supervisor's
// answer to "how long has this engine been unable to see anything" — which is the one number that
// explains a silent alerting system, and so the one number that must never be missing.
//
// Warming is the other explanation for a silent one, and the commoner: a statistical rule that has
// only just been saved is right to say nothing, and without this the endpoint has no way to tell
// its readers the difference between not yet and never.
public sealed record AlertsDto(
    IReadOnlyList<AlertDto> Active,
    IReadOnlyList<AlertDto> History,
    IReadOnlyList<MutedPairDto> Muted,
    IReadOnlyList<RuleDiagnosticDto> Rules,
    int Dropped,
    int WebhooksDropped,
    int Suppressed,
    IReadOnlyList<CappedRuleDto> Capped,
    int BlindSeconds,
    IReadOnlyList<WarmingPairDto> Warming)
{
    public static AlertsDto Of(AlertSnapshot snapshot, int webhooksDropped, int blindSeconds) =>
        new([.. snapshot.Active.Select(AlertDto.Of)],
            [.. snapshot.History.Select(AlertDto.Of)],
            [.. snapshot.Muted.Select(pair => new MutedPairDto(pair.RuleId, pair.Topic, pair.Until))],
            [.. snapshot.Rules.Select(rule => new RuleDiagnosticDto(
                rule.RuleId, rule.Topics, rule.Evaluated, rule.Skipped, rule.LastFiredAt,
                rule.Faulted, rule.FaultReason))],
            snapshot.Dropped,
            webhooksDropped,
            snapshot.Suppressed,
            [.. snapshot.Capped.Select(capped => new CappedRuleDto(capped.RuleId, capped.Untracked))],
            blindSeconds,
            [.. snapshot.Warming.Select(pair => new WarmingPairDto(
                pair.RuleId, pair.Topic, pair.Have, pair.Need))]);
}

/// <summary>A silenced (rule, topic) pair and the moment it starts speaking again.</summary>
public sealed record MutedPairDto(string RuleId, string Topic, DateTimeOffset Until);

/// <summary>What one rule has actually seen. A quiet alert rule is not good news.</summary>
public sealed record RuleDiagnosticDto(
    string RuleId,
    int Topics,
    long Evaluated,
    long Skipped,
    DateTimeOffset? LastFiredAt,
    bool Faulted,
    string? FaultReason);

/// <summary>A rule at a ceiling, and how many topics it has had to stop watching.</summary>
public sealed record CappedRuleDto(string RuleId, int Untracked);

/// <summary>
/// Silence one pair for a while. <c>Minutes: 0</c> lifts a mute that is running.
/// </summary>
// The pair and not an alert id. A mute belongs to (rule, topic) — an alarm that clears and fires
// again an hour later is a different Alert with a different Id, and a mute set on the boiler has
// to outlive that. It is a body rather than a path because a topic carries '/'.
public sealed record MuteRequestDto(string RuleId, string Topic, int Minutes);

/// <summary>A pair still filling the shortest run this server will judge anything on.</summary>
// The sentence is built here rather than in the browser, for the same reason Reason and
// FaultReason are: this endpoint has three readers — the panel, whoever curls it, and whatever a
// person wires it into — and a number pair that each of them phrases for itself is three different
// sentences about one fact. The numbers travel beside it, so a reader that wants a bar has one.
public sealed record WarmingPairDto(string RuleId, string Topic, int Have, int Need)
{
    public string Note => $"warming up, {Have}/{Need}";
}
