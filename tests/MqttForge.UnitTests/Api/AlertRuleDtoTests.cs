using System.Text.Json;
using MqttForge.Api.Contracts;
using MqttForge.Application.Alerts;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using Xunit;

namespace MqttForge.UnitTests.Api;

/// <summary>
/// The rule as the console is allowed to see it, and the rule as it comes back.
///
/// The whole file turns on one asymmetry, and it is the same one SavedConnectionDto is built
/// around: what goes out is not what comes in. A webhook's headers are a bearer token as often as
/// not, so they leave the server as names alone; and because they leave as names alone, a console
/// that saves an unchanged rule has to be able to say 'this header, the one you already have'
/// without ever having been told what it is. That sentence is an empty value, and these tests are
/// what make it mean 'keep' rather than 'delete'.
/// </summary>
public class AlertRuleDtoTests
{
    // The spec's own 'Kural dosyası' rule, the same one AlertJsonShapeTests pins on disk. Built
    // once here for the same reason it is built once there: two copies of the example are two
    // things to keep in step.
    private static AlertRule SpecRule() =>
        new("6f1d", "Kazan sıcaklığı", Enabled: true, "plant/+/temp", "$.temp",
            new ThresholdCondition(ThresholdOp.Gt, 90),
            new ThresholdCondition(ThresholdOp.Lt, 85),
            For: 30, Cooldown: 60, AlertSeverity.Critical,
            [
                new ScreenAction(),
                new WebhookAction(
                    "http://localhost:1880/alarm",
                    new Dictionary<string, string> { ["Authorization"] = "Bearer t" })
            ]);

    /// <summary>A rule on disk carrying one webhook with the headers given.</summary>
    private static AlertRule Stored(string url, params (string Name, string Value)[] headers) =>
        new("6f1d", "Boiler", Enabled: true, "plant/boiler/temp", null,
            new ThresholdCondition(ThresholdOp.Gt, 90), null, null, null, AlertSeverity.Warn,
            [new WebhookAction(url, headers.ToDictionary(h => h.Name, h => h.Value, StringComparer.Ordinal))]);

    /// <summary>What a PUT body says about one webhook.</summary>
    private static AlertActionDto Webhook(string url, IReadOnlyDictionary<string, string>? headers) =>
        new(AlertActionDto.Webhook, url, headers, HeaderNames: null, Topic: null, Qos: null, Retain: null);

    private static AlertRuleDto RuleDto(params AlertActionDto[] actions) =>
        new("6f1d", "Boiler", Enabled: true, "plant/boiler/temp", null,
            new ThresholdCondition(ThresholdOp.Gt, 90), null, null, null, AlertSeverity.Warn, actions);

    private static IReadOnlyDictionary<string, string> HeadersOf(AlertRule rule) =>
        rule.Actions.OfType<WebhookAction>().First().Headers;

    [Fact]
    public void A_screen_action_survives_a_round_trip()
    {
        var dto = AlertActionDto.Of(new ScreenAction());

        Assert.Equal(AlertActionDto.Screen, dto.Type);
        Assert.IsType<ScreenAction>(dto.ToAction(stored: null));
    }

    [Fact]
    public void A_sound_action_survives_a_round_trip()
    {
        var dto = AlertActionDto.Of(new SoundAction());

        Assert.Equal(AlertActionDto.Sound, dto.Type);
        Assert.IsType<SoundAction>(dto.ToAction(stored: null));
    }

    [Fact]
    public void A_publish_action_survives_a_round_trip()
    {
        var dto = AlertActionDto.Of(new PublishAction("mqttforge/alerts/{topic}", 2, Retain: true));

        Assert.Equal("mqttforge/alerts/{topic}", dto.Topic);
        Assert.Equal(2, dto.Qos);
        Assert.True(dto.Retain);

        var back = Assert.IsType<PublishAction>(dto.ToAction(stored: null));

        Assert.Equal("mqttforge/alerts/{topic}", back.Topic);
        Assert.Equal(2, back.Qos);
        Assert.True(back.Retain);
    }

    // Null is not 'no topic', it is 'the default topic', and the difference is a server setting the
    // rule must not bake in. A DTO that helpfully filled the field in would write yesterday's
    // prefix into every rule file the day somebody changed MqttForge:AlertTopicPrefix.
    [Fact]
    public void A_publish_action_with_no_topic_stays_the_default()
    {
        var back = Assert.IsType<PublishAction>(
            AlertActionDto.Of(new PublishAction(null, 0, Retain: false)).ToAction(stored: null));

        Assert.Null(back.Topic);
        Assert.Equal(0, back.Qos);
        Assert.False(back.Retain);
    }

    // SECURITY.md in one assertion: the value is on the server and it stays there.
    [Fact]
    public void A_webhook_goes_out_with_its_header_names_and_none_of_the_values()
    {
        var dto = AlertActionDto.Of(new WebhookAction(
            "http://localhost:1880/alarm",
            new Dictionary<string, string> { ["Authorization"] = "Bearer t", ["X-Plant"] = "north" }));

        Assert.Null(dto.Headers);
        Assert.Equal(["Authorization", "X-Plant"], dto.HeaderNames);
        Assert.DoesNotContain("Bearer t", JsonSerializer.Serialize(dto, AlertRuleJson.Options));
    }

    // The other half of the redaction. Without this, a console that never learnt the value could
    // only ever save the rule by deleting the token, which is a panel that quietly breaks the
    // alerting it was opened to edit.
    [Fact]
    public void A_value_left_empty_keeps_the_one_on_disk()
    {
        var dto = RuleDto(Webhook("http://localhost:1880/alarm",
            new Dictionary<string, string> { ["Authorization"] = "" }));

        var headers = HeadersOf(dto.ToRule(Stored("http://localhost:1880/alarm", ("Authorization", "Bearer t"))));

        Assert.Equal("Bearer t", headers["Authorization"]);
    }

    [Fact]
    public void A_new_value_replaces_the_one_on_disk()
    {
        var dto = RuleDto(Webhook("http://localhost:1880/alarm",
            new Dictionary<string, string> { ["Authorization"] = "Bearer new" }));

        var headers = HeadersOf(dto.ToRule(Stored("http://localhost:1880/alarm", ("Authorization", "Bearer t"))));

        Assert.Equal("Bearer new", headers["Authorization"]);
    }

    // An empty value with nothing behind it is not an error and not a refusal — it is a header the
    // user has added and not filled in yet, and it is theirs to have.
    [Fact]
    public void A_name_the_stored_action_does_not_carry_is_a_new_header()
    {
        var dto = RuleDto(Webhook("http://localhost:1880/alarm",
            new Dictionary<string, string> { ["X-Plant"] = "north", ["X-Line"] = "" }));

        var headers = HeadersOf(dto.ToRule(Stored("http://localhost:1880/alarm", ("Authorization", "Bearer t"))));

        Assert.Equal("north", headers["X-Plant"]);
        Assert.Equal("", headers["X-Line"]);
        Assert.False(headers.ContainsKey("Authorization"));
    }

    // Deleting has to be sayable, and the only way to say it is to leave the name out. That is why
    // the map, when it is given at all, is the whole truth about the headers.
    [Fact]
    public void A_name_left_out_of_the_map_is_deleted()
    {
        var dto = RuleDto(Webhook("http://localhost:1880/alarm",
            new Dictionary<string, string> { ["X-Plant"] = "north" }));

        var headers = HeadersOf(dto.ToRule(
            Stored("http://localhost:1880/alarm", ("Authorization", "Bearer t"), ("X-Plant", "south"))));

        Assert.Single(headers);
        Assert.Equal("north", headers["X-Plant"]);
    }

    // The trap this exists to close: the panel has three writers and two of them — the enabled
    // switch and the delete button — send a rule back that they never opened the header editor on.
    // If an absent map meant 'no headers', flipping a switch would silently disarm the webhook.
    [Fact]
    public void Headers_left_out_altogether_are_kept_whole()
    {
        var dto = RuleDto(new AlertActionDto(
            AlertActionDto.Webhook, "http://localhost:1880/alarm",
            Headers: null, HeaderNames: ["Authorization"], Topic: null, Qos: null, Retain: null));

        var headers = HeadersOf(dto.ToRule(Stored("http://localhost:1880/alarm", ("Authorization", "Bearer t"))));

        Assert.Equal("Bearer t", headers["Authorization"]);
    }

    // 'authorization' and 'Authorization' are one header to every HTTP stack there is, so a
    // console that lower-cases what it got from the GET must still get its value back.
    [Fact]
    public void A_name_written_in_another_case_still_finds_its_value()
    {
        var dto = RuleDto(Webhook("http://localhost:1880/alarm",
            new Dictionary<string, string> { ["authorization"] = "" }));

        var headers = HeadersOf(dto.ToRule(Stored("http://localhost:1880/alarm", ("Authorization", "Bearer t"))));

        // Kept under the spelling the caller used, because that is the one the caller will look
        // for next time — the value is what was being preserved, not the capitalisation.
        Assert.Equal("Bearer t", headers["authorization"]);
    }

    // The reason the match is made on the URL and not on a position in the list. A token belongs
    // to an endpoint; carrying it to a new address because it sat in the same row is how a
    // redaction turns into a leak.
    [Fact]
    public void A_webhook_whose_url_changed_cannot_borrow_the_old_values()
    {
        var dto = RuleDto(Webhook("http://elsewhere.example/hook",
            new Dictionary<string, string> { ["Authorization"] = "" }));

        var headers = HeadersOf(dto.ToRule(Stored("http://localhost:1880/alarm", ("Authorization", "Bearer t"))));

        Assert.Equal("", headers["Authorization"]);
    }

    [Fact]
    public void Headers_are_taken_from_the_stored_webhook_with_the_same_url()
    {
        var stored = new AlertRule("6f1d", "Boiler", Enabled: true, "plant/boiler/temp", null,
            new ThresholdCondition(ThresholdOp.Gt, 90), null, null, null, AlertSeverity.Warn,
            [
                new WebhookAction("http://a.example/hook",
                    new Dictionary<string, string> { ["Authorization"] = "for a" }),
                new WebhookAction("http://b.example/hook",
                    new Dictionary<string, string> { ["Authorization"] = "for b" })
            ]);

        var dto = RuleDto(Webhook("http://b.example/hook",
            new Dictionary<string, string> { ["Authorization"] = "" }));

        Assert.Equal("for b", HeadersOf(dto.ToRule(stored))["Authorization"]);
    }

    // The spec: "Id taşımayan kurala sunucu bir id verir". Hex, because the id is a topic level in
    // the default publish topic and a topic level cannot hold a '/'.
    [Fact]
    public void A_rule_with_no_id_is_given_one()
    {
        var first = RuleDto() with { Id = null };

        var id = first.ToRule(stored: null).Id;

        Assert.Equal(32, id.Length);
        Assert.All(id, character => Assert.Contains(character, "0123456789abcdef"));
        Assert.NotEqual(id, (first with { Id = null }).ToRule(stored: null).Id);
    }

    [Fact]
    public void A_rule_that_carries_an_id_keeps_it()
    {
        Assert.Equal("6f1d", RuleDto().ToRule(stored: null).Id);
    }

    // The file, the wire and web/src/types/api.ts are one shape, and the only property on which
    // the DTO is allowed to differ from the record is actions — because that is the redaction.
    // Compared as bytes rather than property by property: the naming policy, the enum converter
    // and the encoder all show up here, and so would anything a later edit adds to either side.
    [Fact]
    public void The_dto_and_the_rule_write_the_same_bytes_up_to_their_actions()
    {
        var rule = SpecRule();

        var onDisk = JsonSerializer.Serialize(rule, AlertRuleJson.Options);
        var onTheWire = JsonSerializer.Serialize(AlertRuleDto.Of(rule), AlertRuleJson.Options);

        var head = onDisk.IndexOf(""","actions":""", StringComparison.Ordinal);

        Assert.True(head > 0);
        Assert.Equal(onDisk[..head], onTheWire[..head]);

        // And the tail is the difference, spelled out rather than described. The optional members
        // are omitted when null, so a screen action is two words on the wire and a webhook is the
        // spec's "dışarı: { url, headerNames }" exactly.
        Assert.EndsWith(
            ""","actions":[{"type":"screen"},{"type":"webhook","url":"http://localhost:1880/alarm","headerNames":["Authorization"]}]}""",
            onTheWire, StringComparison.Ordinal);
    }

    // AlertDto carries its channels as words, and those words have to be the same words the file
    // writes — otherwise the console's 'this rule makes a noise' and the file's 'type: sound' are
    // two vocabularies that agree until somebody renames one of them.
    [Fact]
    public void The_channel_word_is_the_discriminator_the_file_writes()
    {
        AlertAction[] actions =
        [
            new ScreenAction(),
            new SoundAction(),
            new WebhookAction("http://localhost:1880/alarm", new Dictionary<string, string>()),
            new PublishAction(null, 0, Retain: false)
        ];

        foreach (var action in actions)
        {
            using var written = JsonDocument.Parse(JsonSerializer.Serialize(action, AlertRuleJson.Options));

            Assert.Equal(written.RootElement.GetProperty("type").GetString(), AlertActionDto.NameOf(action));
        }
    }

    // The validator refuses this first, and this is the second line: a Type nobody recognises must
    // not become a silently dropped action. A rule saved with one channel missing is a rule that
    // fires and tells nobody, which is the failure this whole feature exists to prevent.
    [Fact]
    public void An_unknown_action_type_is_refused()
    {
        var dto = new AlertActionDto("telegram", null, null, null, null, null, null);

        var thrown = Assert.Throws<ArgumentOutOfRangeException>(() => dto.ToAction(stored: null));

        Assert.Contains("telegram", thrown.Message, StringComparison.Ordinal);
    }
}
