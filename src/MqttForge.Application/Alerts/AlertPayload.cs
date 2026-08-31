using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Alerts;

/// <summary>
/// The one body both outgoing channels send. The spec's "Dışarı giden gövde" section, written
/// down once.
/// </summary>
// One builder for the webhook and the publish, because they are one contract. Two builders would
// be two shapes within a fortnight, and the person who has to notice is running an integration
// against both of them on somebody else's plant.
//
// It lives in Application rather than beside the dispatchers in Infrastructure for the reason
// AlertRuleJson gives: Infrastructure cannot see Api, both dispatchers are in Infrastructure, and
// the shape has to be reachable from the tests that pin it against the document.
public static class AlertPayload
{
    /// <summary>The most of a message body that goes out with an alert.</summary>
    // Four kilobytes, from the spec's table: enough to be evidence, small enough that a plant
    // publishing a whole image cannot turn one alarm into a delivery nobody's endpoint accepts.
    // AlertDto clips harder still — 256 bytes — because a panel is showing a hundred rows and a
    // human reads the first line of any of them.
    //
    // AlertEngineCore already clips its own sample to 4096 *characters*, so this bites only on a
    // body that is not ASCII. Both ceilings are kept: the core's protects its own memory, and
    // this one is about what crosses the wire, which is measured in bytes by everything that
    // carries it.
    public const int SampleLimit = 4096;

    /// <summary>
    /// The instant format every timestamp in this body uses: UTC, milliseconds, and a Z.
    /// </summary>
    // Not the serialiser's own DateTimeOffset writing, which would produce '+00:00'. That is
    // correct ISO 8601 and it is the form that surprises: the endpoint receiving this was written
    // by whoever operates the plant, probably not in .NET, and 'Z' is the spelling every one of
    // those stacks parses without being asked twice. It is also what the spec's example shows.
    private const string Instant = "yyyy-MM-dd'T'HH:mm:ss.fff'Z'";

    /// <param name="event"><c>raised</c> or <c>resolved</c>.</param>
    /// <param name="field">
    /// The field the rule extracts, when the caller knows it. <see cref="Alert"/> does not carry
    /// one — it is a property of the rule — so a dispatcher, which is handed alerts and no rules,
    /// leaves it out and the member is omitted from the body.
    /// </param>
    public static string For(Alert alert, string @event, string? field = null) =>
        JsonSerializer.Serialize(
            new Body(
                @event,
                new RuleRef(alert.RuleId, alert.RuleName),
                alert.Topic,
                field,
                alert.Severity,
                At(alert.FiredAt),
                alert.Reason,
                alert.Value,
                Clip(alert.Sample),
                // A raised body carries neither of these at all, and a resolved one carries both.
                // The spec puts it exactly that way — "the same body, with resolvedAt and
                // resolvedBy" — and it is read off the alert rather than off the event word, so a
                // body that says 'resolved' can never disagree with the record it was built from.
                alert.ResolvedAt is { } resolved ? At(resolved) : null,
                alert.ResolvedBy),
            // The rules file's options, and not a set built here. camelCase, and enums as their
            // camelCase names — 'critical', which answers a question that a 2 only raises. A
            // second configuration would let this body and the file it describes drift apart while
            // every test stayed green.
            AlertRuleJson.Options);

    private static string At(DateTimeOffset moment) =>
        moment.ToUniversalTime().ToString(Instant, CultureInfo.InvariantCulture);

    /// <summary>The sample, cut to the byte budget and never in the middle of a character.</summary>
    private static string? Clip(string? sample)
    {
        if (sample is null) return null;

        // The ordinary path pays one comparison and allocates nothing. No character encodes to
        // more than three UTF-8 bytes — the four-byte ones are surrogate pairs, which are two
        // chars — so a string this short cannot possibly exceed the budget.
        if (sample.Length <= SampleLimit / 3) return sample;

        var bytes = Encoding.UTF8.GetBytes(sample);
        if (bytes.Length <= SampleLimit) return sample;

        var end = SampleLimit;

        // Walk back off a continuation byte (10xxxxxx). Cutting the array at the budget can land
        // inside a character, and half a character on the wire is either a U+FFFD in somebody's
        // database or a body their parser rejects outright.
        while (end > 0 && (bytes[end] & 0xC0) == 0x80) end--;

        return Encoding.UTF8.GetString(bytes, 0, end);
    }

    /// <summary>The body, as a type, so its member order is the document's member order.</summary>
    // A record rather than a hand-written writer: the order is the declaration order, the names
    // come from one naming policy, and nobody can add a member to one channel's body and forget
    // the other's. The three WhenWritingNull members are the ones whose absence means something —
    // 'this rule extracts no field', 'this alert has not ended' — while value and sample are
    // always written, because 'the rule produced no number' is an answer and it is not the same
    // as this build having stopped sending numbers.
    private sealed record Body(
        string Event,
        RuleRef Rule,
        string Topic,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Field,
        AlertSeverity Severity,
        string At,
        string Reason,
        double? Value,
        string? Sample,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ResolvedAt,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ResolvedBy);

    /// <summary>The rule, as much of it as anyone downstream has any business with.</summary>
    // Nested rather than flat 'ruleId'/'ruleName' because the spec nests it, and nested is right:
    // a receiver routing on the rule wants one object to look at, and the day this carries a third
    // member it goes inside rather than growing a third prefix.
    private sealed record RuleRef(string Id, string Name);
}
