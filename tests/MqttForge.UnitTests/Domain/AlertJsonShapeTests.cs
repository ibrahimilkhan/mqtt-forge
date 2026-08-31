using System.Text.Json;
using MqttForge.Api.Contracts;
using MqttForge.Application.Alerts;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Domain;

// Every assertion here runs against AlertRuleJson.Options rather than a set of options this file
// made up. The rule file and the hub carry the same shape by design — the spec puts the disk shape
// and web/src/types/api.ts side by side — so a test with its own JsonSerializerOptions would go
// green on a document nothing else in the repo can read, which is the one failure that matters.
// The two tests in the middle of this file are what hold AlertRuleJson.Options and WireJson.Client
// together, since they are two objects and nothing but a test can stop them drifting.
public class AlertJsonShapeTests
{
    private static readonly JsonSerializerOptions Options = AlertRuleJson.Options;

    // The spec's own 'Kural dosyası' example, built once because three tests below need the same
    // rule and a second copy would be a second thing to keep in step.
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

    // The discriminator is written first by System.Text.Json and, as the last refusal test in this
    // file pins, has to be read first too — so every literal below is the exact text the serialiser
    // produces, not a tidied-up equivalent.
    [Theory]
    [InlineData(nameof(ThresholdCondition), """{"type":"threshold","op":"gt","value":90}""")]
    [InlineData(nameof(ThresholdCondition), """{"type":"threshold","op":"gte","value":12.5}""")]
    [InlineData(nameof(BandCondition), """{"type":"band","low":4,"high":20,"inside":true}""")]
    [InlineData(nameof(PatternCondition), """{"type":"pattern","regex":"^ERR-","negate":false}""")]
    [InlineData(nameof(OneOfCondition), """{"type":"oneOf","values":["on","off"],"negate":true}""")]
    [InlineData(nameof(AllCondition), """{"type":"all","of":[{"type":"threshold","op":"lt","value":1}]}""")]
    [InlineData(nameof(AnyCondition), """{"type":"any","of":[]}""")]
    [InlineData(nameof(SilenceCondition), """{"type":"silence","after":300}""")]
    // The member order is the record's own — method, k, window — and it is pinned here because
    // this is the shape the spec writes and the shape web/src/types/api.ts will have to read.
    [InlineData(nameof(OutlierCondition), """{"type":"outlier","method":"tukey","k":1.5,"window":200}""")]
    [InlineData(nameof(OutlierCondition), """{"type":"outlier","method":"sigma","k":3,"window":0}""")]
    public void Every_condition_survives_a_round_trip(string expectedType, string json)
    {
        var condition = JsonSerializer.Deserialize<AlertCondition>(json, Options)!;

        Assert.Equal(expectedType, condition.GetType().Name);
        Assert.Equal(json, JsonSerializer.Serialize(condition, Options));
    }
    [Theory]
    [InlineData(nameof(ScreenAction), """{"type":"screen"}""")]
    [InlineData(nameof(SoundAction), """{"type":"sound"}""")]
    [InlineData(nameof(WebhookAction), """{"type":"webhook","url":"http://localhost:1880/alarm","headers":{"Authorization":"Bearer t"}}""")]
    [InlineData(nameof(PublishAction), """{"type":"publish","topic":null,"qos":1,"retain":true}""")]
    public void Every_action_survives_a_round_trip(string expectedType, string json)
    {
        var action = JsonSerializer.Deserialize<AlertAction>(json, Options)!;

        Assert.Equal(expectedType, action.GetType().Name);
        Assert.Equal(json, JsonSerializer.Serialize(action, Options));
    }

    // The union is recursive, and a union that only round-trips at depth one is a union that
    // works until the first user writes 'temperature over 90 AND (fan off OR door open)'.
    [Fact]
    public void An_all_can_hold_an_any_and_come_back_whole()
    {
        const string json = """{"type":"all","of":[{"type":"threshold","op":"lt","value":1},{"type":"any","of":[{"type":"pattern","regex":"^ERR-","negate":false}]}]}""";

        var all = Assert.IsType<AllCondition>(JsonSerializer.Deserialize<AlertCondition>(json, Options));
        var any = Assert.IsType<AnyCondition>(all.Of[1]);
        var pattern = Assert.IsType<PatternCondition>(any.Of[0]);

        Assert.Equal("^ERR-", pattern.Regex);
        Assert.False(pattern.Negate);
        Assert.Equal(json, JsonSerializer.Serialize<AlertCondition>(all, Options));
    }

    // 'outlier' used to stand here as the type a later build would bring, and it has now arrived,
    // so the stand-in is a name no build of this tool carries. The property is unchanged and it is
    // the one that matters: a rule file written against a newer build has to be refused loudly
    // rather than read as something else.
    [Theory]
    [InlineData("""{"type":"forecast","window":200,"ahead":30}""")]
    [InlineData("""{"type":"","value":1}""")]
    public void An_unknown_condition_type_is_refused(string json)
    {
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<AlertCondition>(json, Options));
    }
    [Fact]
    public void An_unknown_action_type_is_refused()
    {
        Assert.Throws<JsonException>(
            () => JsonSerializer.Deserialize<AlertAction>("""{"type":"telegram","chatId":7}""", Options));
    }

    // Not a JsonException, and worth knowing which: System.Text.Json reads the discriminator as a
    // streaming decision, so a hand-edited file with "type" written last fails exactly as a file
    // with no "type" at all does. Whoever loads alert-rules.json has to catch both.
    [Theory]
    [InlineData("""{"op":"gt","value":90}""")]
    [InlineData("""{"op":"gt","value":90,"type":"threshold"}""")]
    public void A_condition_whose_type_is_missing_or_written_last_is_refused(string json)
    {
        Assert.Throws<NotSupportedException>(() => JsonSerializer.Deserialize<AlertCondition>(json, Options));
    }

    // The spec's own 'Kural dosyası' example, to the byte. Two escapes are the serialiser's
    // defaults rather than anything this repo chose, and both are pinned here so that a later
    // change of encoder is a red test and not a rule file the previous build cannot read:
    // the Turkish letters in the name become \uXXXX with upper-case hex, and the '+' wildcard in
    // the filter becomes \u002B because the default JavaScript encoder escapes it.
    [Fact]
    public void A_rule_is_written_exactly_as_the_spec_writes_it()
    {
        const string expected = """
            {"id":"6f1d","name":"Kazan s\u0131cakl\u0131\u011F\u0131","enabled":true,"filter":"plant/\u002B/temp","field":"$.temp","condition":{"type":"threshold","op":"gt","value":90},"clear":{"type":"threshold","op":"lt","value":85},"for":30,"cooldown":60,"severity":"critical","actions":[{"type":"screen"},{"type":"webhook","url":"http://localhost:1880/alarm","headers":{"Authorization":"Bearer t"}}]}
            """;

        Assert.Equal(expected, JsonSerializer.Serialize(SpecRule(), Options));
    }

    // The whole reason AlertRuleJson exists as one holder rather than two. The store cannot use
    // WireJson.Client — Infrastructure does not reference Api — so there are necessarily two
    // JsonSerializerOptions objects for one shape, and only a test can stop them drifting. Written
    // as bytes on both sides rather than as a comparison of properties, because it is the output
    // that has to agree: the naming policy, the enum converter and the encoder all show up here,
    // and so would anything a future edit adds to either one.
    [Fact]
    public void The_file_and_the_wire_write_and_read_the_same_bytes()
    {
        var rule = SpecRule();

        var onDisk = JsonSerializer.Serialize(rule, AlertRuleJson.Options);
        var onTheWire = JsonSerializer.Serialize(rule, WireJson.Client);

        Assert.Equal(onTheWire, onDisk);

        // And in both directions: an options set that wrote the same bytes but read them back
        // differently would still be a file the API could not accept.
        Assert.Equal(AlertSeverity.Critical,
            JsonSerializer.Deserialize<AlertRule>(onTheWire, AlertRuleJson.Options)!.Severity);
        Assert.Equal(AlertSeverity.Critical,
            JsonSerializer.Deserialize<AlertRule>(onDisk, WireJson.Client)!.Severity);
    }

    // File differs from Options in exactly one way, and the test says which. Someone will one day
    // reach for AlertRuleJson.File on the hub because it is the one they remember the name of, and
    // the only thing that would go wrong is a larger frame — which is the point: the two are the
    // same contract, laid out differently for two different readers.
    [Fact]
    public void The_indented_file_reads_back_as_the_same_rule()
    {
        var rule = SpecRule();
        var indented = JsonSerializer.Serialize(rule, AlertRuleJson.File);

        Assert.True(AlertRuleJson.File.WriteIndented);
        Assert.False(AlertRuleJson.Options.WriteIndented);
        Assert.Contains("\n", indented);
        Assert.Equal(
            JsonSerializer.Serialize(rule, AlertRuleJson.Options),
            JsonSerializer.Serialize(
                JsonSerializer.Deserialize<AlertRule>(indented, AlertRuleJson.Options), AlertRuleJson.Options));
    }

    // The console reads severity as a word and colours a row by it. A number here would be a
    // panel that draws '2' where it meant to draw 'critical'.
    [Fact]
    public void An_alert_carries_its_severity_as_a_name_and_its_actions_as_a_union()
    {
        var at = new DateTimeOffset(2026, 8, 30, 9, 14, 22, 104, TimeSpan.Zero);
        var alert = new Alert(
            "a1", "6f1d", "Kazan sıcaklığı", "plant/boiler/temp", AlertSeverity.Critical,
            at, at, ResolvedAt: null, ResolvedBy: null, MutedUntil: null,
            Count: 3, "94.2 > 90", 94.2, """{"temp":94.2}""",
            [new ScreenAction(), new SoundAction()]);

        var json = JsonSerializer.Serialize(alert, Options);

        Assert.Contains("""'severity':'critical'""".Replace('\'', '"'), json);
        Assert.Contains("""'actions':[{'type':'screen'},{'type':'sound'}]""".Replace('\'', '"'), json);

        var back = JsonSerializer.Deserialize<Alert>(json, Options)!;

        Assert.Equal(AlertSeverity.Critical, back.Severity);
        Assert.Equal(at, back.FiredAt);
        Assert.Null(back.ResolvedAt);
        Assert.Equal(2, back.Actions.Count);
    }

    // The whole reason this record exists rather than a bare list. A store that answered an
    // unreadable file with an empty document would let the next save delete every rule the user
    // wrote, which is the failure the spec's 'Kural dosyası bir kayıttır' section is about.
    [Fact]
    public void An_unreadable_document_is_not_an_empty_one()
    {
        var empty = new AlertRuleDocument([], Unreadable: false, []);
        var unreadable = new AlertRuleDocument([], Unreadable: true, []);

        Assert.NotEqual(empty, unreadable);
        Assert.Equal(empty, new AlertRuleDocument([], Unreadable: false, []));
        Assert.Empty(unreadable.Rules);
    }

    // A trap worth a test rather than a comment: two conditions with the same contents are NOT
    // equal when the contents include a list, because the compiler-generated Equals compares the
    // list by reference. Reconciliation therefore cannot ask 'is this the same condition?' — it
    // has to go through final task 11's ConfigHash, and this test is what says so out loud.
    [Fact]
    public void Conditions_that_carry_a_list_do_not_compare_by_value()
    {
        Assert.Equal(
            new ThresholdCondition(ThresholdOp.Gt, 90),
            new ThresholdCondition(ThresholdOp.Gt, 90));

        Assert.NotEqual<AlertCondition>(
            new OneOfCondition(["on"], Negate: false),
            new OneOfCondition(["on"], Negate: false));

        Assert.NotEqual<AlertCondition>(
            new AllCondition([new ThresholdCondition(ThresholdOp.Gt, 90)]),
            new AllCondition([new ThresholdCondition(ThresholdOp.Gt, 90)]));
    }

    // The six-argument construction is what both existing call sites use, and it has to keep
    // meaning 'a live message'. A default of true, or a required seventh argument, would have
    // made every retained last value in the repo either invisible to the engine or a build break.
    [Fact]
    public void A_message_is_not_a_replay_unless_it_says_so()
    {
        var live = new MqttMessage("plant/boiler/temp", "94.2", "text", 0, Retain: true, DateTimeOffset.UnixEpoch);
        var replayed = live with { Replay = true };

        Assert.False(live.Replay);
        Assert.True(replayed.Replay);
        Assert.True(live.Retain);
        Assert.NotEqual(live, replayed);
    }

    // The statistical family on disk. Every literal is the exact text the serialiser produces, so
    // a renamed property or a re-ordered record fails here rather than in somebody's hand-edited
    // alert-rules.json — which is the file this shape exists for.
    [Theory]
    [InlineData(nameof(OutlierCondition), """{"type":"outlier","method":"tukey","k":1.5,"window":200}""")]
    [InlineData(nameof(OutlierCondition), """{"type":"outlier","method":"sigma","k":3,"window":500}""")]
    [InlineData(nameof(DistributionShiftCondition), """{"type":"distributionShift","window":200}""")]
    [InlineData(nameof(ShapeChangeCondition), """{"type":"shapeChange","window":2000}""")]
    [InlineData(nameof(PulseCondition), """{"type":"pulse","metric":"period","op":"gt","value":8000,"window":200}""")]
    [InlineData(nameof(PulseCondition), """{"type":"pulse","metric":"duty","op":"lt","value":0.1,"window":200}""")]
    public void Every_statistical_condition_survives_a_round_trip(string expectedType, string json)
    {
        var condition = JsonSerializer.Deserialize<AlertCondition>(json, Options)!;

        Assert.Equal(expectedType, condition.GetType().Name);
        Assert.Equal(json, JsonSerializer.Serialize(condition, Options));
    }

    // A statistical condition nested in a composite, because that is how the useful ones are
    // written: 'the pump has stopped pulsing AND the line is still pressurised'.
    [Fact]
    public void A_statistical_condition_round_trips_inside_a_composite()
    {
        const string json = """{"type":"all","of":[{"type":"pulse","metric":"count","op":"eq","value":0,"window":200},{"type":"threshold","op":"gt","value":2}]}""";

        var all = Assert.IsType<AllCondition>(JsonSerializer.Deserialize<AlertCondition>(json, Options));
        var pulse = Assert.IsType<PulseCondition>(all.Of[0]);

        Assert.Equal(PulseMetric.Count, pulse.Metric);
        Assert.Equal(200, pulse.Window);
        Assert.Equal(json, JsonSerializer.Serialize<AlertCondition>(all, Options));
    }
}
