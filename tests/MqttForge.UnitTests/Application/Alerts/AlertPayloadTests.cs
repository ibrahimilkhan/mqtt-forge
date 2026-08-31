using System.Text;
using System.Text.Json;
using MqttForge.Application.Alerts;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Alerts;

/// <summary>
/// The one body both outgoing channels send, against the example in the spec's
/// "Dışarı giden gövde" section.
/// </summary>
// This is a published contract with somebody else's system: the endpoint on the other end was
// written by whoever operates the plant, it is very probably not .NET, and it cannot be
// redeployed because a member of ours moved. So these tests read the JSON as text rather than
// round-tripping it through a type — a round trip would pass happily while the names, the order
// and the instant format all drifted.
public class AlertPayloadTests
{
    private static readonly DateTimeOffset Fired = new(2026, 8, 30, 9, 14, 22, 104, TimeSpan.Zero);

    private static Alert Alarm(
        double? value = 94.2,
        string? sample = "{\"temp\":94.2,\"fan\":\"off\"}",
        DateTimeOffset? resolvedAt = null,
        string? resolvedBy = null) =>
        new("a1", "hot", "Boiler temperature", "plant/boiler/temp", AlertSeverity.Critical,
            Fired, Fired, resolvedAt, resolvedBy, MutedUntil: null, Count: 1, Reason: "94.2 > 90",
            value, sample, [new ScreenAction()]);

    private static JsonElement Parsed(string json) => JsonDocument.Parse(json).RootElement.Clone();

    private static IReadOnlyList<string> NamesOf(JsonElement body) =>
        [.. body.EnumerateObject().Select(member => member.Name)];

    [Fact]
    public void The_body_carries_the_fields_the_spec_shows_in_the_order_it_shows_them()
    {
        var body = Parsed(AlertPayload.For(Alarm(), "raised", "$.temp"));

        // The order as well as the names. It is not semantically load-bearing in JSON and it is
        // read-bearing: somebody debugging a delivery at three in the morning is comparing this
        // against the document, and a shuffled body costs them a minute every time.
        Assert.Equal(["event", "rule", "topic", "field", "severity", "at", "reason", "value", "sample"],
            NamesOf(body));

        Assert.Equal("raised", body.GetProperty("event").GetString());
        Assert.Equal("hot", body.GetProperty("rule").GetProperty("id").GetString());
        Assert.Equal("Boiler temperature", body.GetProperty("rule").GetProperty("name").GetString());
        Assert.Equal("plant/boiler/temp", body.GetProperty("topic").GetString());
        Assert.Equal("$.temp", body.GetProperty("field").GetString());
        Assert.Equal("critical", body.GetProperty("severity").GetString());
        Assert.Equal("2026-08-30T09:14:22.104Z", body.GetProperty("at").GetString());
        Assert.Equal("94.2 > 90", body.GetProperty("reason").GetString());
        Assert.Equal(94.2, body.GetProperty("value").GetDouble());
        Assert.Equal("{\"temp\":94.2,\"fan\":\"off\"}", body.GetProperty("sample").GetString());
    }

    [Fact]
    public void A_rule_that_extracts_no_field_leaves_field_out()
    {
        var body = Parsed(AlertPayload.For(Alarm(), "raised"));

        // Left out rather than sent as null. A receiver's `if ("field" in body)` is the ordinary
        // way to ask, and a null would answer 'yes, and it is nothing'.
        Assert.DoesNotContain("field", NamesOf(body));
    }

    [Fact]
    public void A_raised_body_carries_nothing_about_a_resolution()
    {
        var body = Parsed(AlertPayload.For(Alarm(), "raised"));

        Assert.DoesNotContain("resolvedAt", NamesOf(body));
        Assert.DoesNotContain("resolvedBy", NamesOf(body));
    }

    [Fact]
    public void The_resolved_body_is_the_same_body_with_the_resolution_on_the_end()
    {
        var cleared = new DateTimeOffset(2026, 8, 30, 9, 20, 0, TimeSpan.Zero);

        var body = Parsed(AlertPayload.For(
            Alarm(resolvedAt: cleared, resolvedBy: "clear"), "resolved", "$.temp"));

        Assert.Equal(
            ["event", "rule", "topic", "field", "severity", "at", "reason", "value", "sample",
             "resolvedAt", "resolvedBy"],
            NamesOf(body));

        Assert.Equal("resolved", body.GetProperty("event").GetString());
        Assert.Equal("2026-08-30T09:20:00.000Z", body.GetProperty("resolvedAt").GetString());
        Assert.Equal("clear", body.GetProperty("resolvedBy").GetString());

        // `at` is still when it rang. The alert's own sentence does not get rewritten on the way
        // out, and neither does its moment: a resolved body whose `at` had moved to the
        // resolution would lose the only record of when the plant went wrong.
        Assert.Equal("2026-08-30T09:14:22.104Z", body.GetProperty("at").GetString());
    }

    [Fact]
    public void Moments_are_written_in_utc_with_a_z()
    {
        // The same instant, told in a timezone that is not UTC. A body that carried '+03:00'
        // would be correct ISO 8601 and would still be the thing that makes somebody's log
        // correlation an hour and a half out.
        var local = new DateTimeOffset(2026, 8, 30, 12, 44, 22, 104, TimeSpan.FromHours(3.5));
        var alert = Alarm() with { FiredAt = local };

        var body = Parsed(AlertPayload.For(alert, "raised"));

        Assert.Equal("2026-08-30T09:14:22.104Z", body.GetProperty("at").GetString());
    }

    [Fact]
    public void Severity_is_a_name_and_never_a_number()
    {
        var body = Parsed(AlertPayload.For(Alarm() with { Severity = AlertSeverity.Warn }, "raised"));

        Assert.Equal(JsonValueKind.String, body.GetProperty("severity").ValueKind);
        Assert.Equal("warn", body.GetProperty("severity").GetString());
    }

    [Fact]
    public void A_missing_value_and_a_missing_sample_are_written_as_null()
    {
        // A pattern rule has no number and a silence rule has no message at all. Both are sent as
        // null rather than dropped, because 'the rule produced no value' is an answer a receiver
        // may want to see, and it is different from 'this build stopped sending values'.
        var body = Parsed(AlertPayload.For(Alarm(value: null, sample: null), "raised"));

        Assert.Equal(JsonValueKind.Null, body.GetProperty("value").ValueKind);
        Assert.Equal(JsonValueKind.Null, body.GetProperty("sample").ValueKind);
    }

    [Fact]
    public void A_sample_over_four_kilobytes_is_clipped()
    {
        var body = Parsed(AlertPayload.For(Alarm(sample: new string('a', 5000)), "raised"));

        var sample = body.GetProperty("sample").GetString()!;

        Assert.Equal(AlertPayload.SampleLimit, Encoding.UTF8.GetByteCount(sample));
        Assert.StartsWith("aaaa", sample);
    }

    [Fact]
    public void A_clip_never_cuts_a_character_in_half()
    {
        // Three bytes each in UTF-8, so the budget does not land on a character boundary. Cutting
        // the byte array at 4096 would put half a euro sign on the wire, and the receiver would
        // either see U+FFFD or refuse the body outright.
        var body = Parsed(AlertPayload.For(Alarm(sample: new string('€', 3000)), "raised"));

        var sample = body.GetProperty("sample").GetString()!;

        Assert.True(Encoding.UTF8.GetByteCount(sample) <= AlertPayload.SampleLimit,
            "the clipped sample must fit the budget");
        Assert.DoesNotContain('\uFFFD', sample);
        Assert.Equal('€', sample[^1]);
    }
}
