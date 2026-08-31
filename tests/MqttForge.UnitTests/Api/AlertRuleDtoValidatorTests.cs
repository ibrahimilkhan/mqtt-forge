using System.Text.Json;
using MqttForge.Api.Contracts;
using MqttForge.Api.Validation;
using MqttForge.Application.Alerts;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using Xunit;

namespace MqttForge.UnitTests.Api;

/// <summary>
/// The rules the editor's Save button is locked by, on the server side where they are enforceable.
///
/// Two kinds of thing are refused here and they are worth telling apart. The first is a rule that
/// cannot work: a filter that is not a filter, a regex that does not compile, a QoS of 5. The
/// second, and the one this file exists for, is a rule that saves perfectly and then does
/// something nobody asked for — a wildcard rule that retains every alarm on top of the last one, a
/// publish topic that walks out of the alert tree and into the plant, a filter that subscribes the
/// engine to its own alarms. Those are all valid MQTT and all wrong, and the moment to say so is
/// while the person who wrote it is still looking at it.
/// </summary>
public class AlertRuleDtoValidatorTests
{
    private readonly AlertRulesDtoValidator _validator = new(new AlertEngineOptions());

    private bool IsValid(params AlertRuleDto[] rules) =>
        _validator.Validate(new AlertRulesDto(rules)).IsValid;

    private string Message(params AlertRuleDto[] rules) =>
        string.Join(" | ", _validator.Validate(new AlertRulesDto(rules)).Errors.Select(e => e.ErrorMessage));

    private static AlertActionDto Screen() =>
        new(AlertActionDto.Screen, null, null, null, null, null, null);

    private static AlertActionDto Webhook(string url, IReadOnlyDictionary<string, string>? headers = null) =>
        new(AlertActionDto.Webhook, url, headers, null, null, null, null);

    private static AlertActionDto Publish(string? topic, int qos = 0, bool retain = false) =>
        new(AlertActionDto.Publish, null, null, null, topic, qos, retain);

    private static AlertRuleDto Rule(
        string? id = "6f1d",
        string name = "Boiler",
        string filter = "plant/boiler/temp",
        AlertCondition? condition = null,
        int? forSeconds = null,
        int? cooldown = null,
        AlertSeverity severity = AlertSeverity.Warn,
        IReadOnlyList<AlertActionDto>? actions = null) =>
        new(id, name, Enabled: true, filter, Field: null,
            condition ?? new ThresholdCondition(ThresholdOp.Gt, 90),
            Clear: null, forSeconds, cooldown, severity, actions ?? [Screen()]);

    [Fact]
    public void A_plain_rule_is_valid()
    {
        Assert.True(IsValid(Rule()));
    }

    [Theory]
    [InlineData("plant/boiler/temp")]
    [InlineData("plant/+/temp")]
    [InlineData("plant/#")]
    // An empty segment is legal MQTT: 'a//b' has three levels, the middle one empty.
    [InlineData("a//b")]
    public void Accepts_a_well_formed_filter(string filter)
    {
        Assert.True(IsValid(Rule(filter: filter)));
    }

    [Theory]
    [InlineData("")]
    [InlineData("a/#/b")]
    [InlineData("a/b#")]
    [InlineData("a/+b")]
    [InlineData("a/\0/b")]
    public void Refuses_a_malformed_filter(string filter)
    {
        Assert.False(IsValid(Rule(filter: filter)));
    }

    // The loop. The engine publishes its own alarms under the prefix and drops anything arriving
    // from under it, so a rule filtering over that tree is not a feedback loop — it is worse: a
    // subscription that costs bandwidth, matches messages, and can never once fire. Refusing it is
    // the only way the person who wrote it ever finds out.
    [Theory]
    [InlineData("#")]
    [InlineData("mqttforge/#")]
    [InlineData("mqttforge/alerts/#")]
    [InlineData("+/+/+")]
    [InlineData("mqttforge/+/boiler")]
    public void Refuses_a_filter_that_covers_the_engines_own_prefix(string filter)
    {
        Assert.False(IsValid(Rule(filter: filter)));
    }

    // And the near misses stay legal. 'mqttforge/alerts' is the level above the tree, not in it,
    // and a rule watching a plant that happens to be called mqttforge/something-else is fine.
    [Theory]
    [InlineData("mqttforge/alerts")]
    [InlineData("mqttforge/+")]
    [InlineData("mqttforge/config/#")]
    public void Accepts_a_filter_that_stops_short_of_the_prefix(string filter)
    {
        Assert.True(IsValid(Rule(filter: filter)));
    }

    [Fact]
    public void Refuses_an_empty_name()
    {
        Assert.False(IsValid(Rule(name: "")));
    }

    [Fact]
    public void Refuses_a_name_over_eighty_characters()
    {
        Assert.False(IsValid(Rule(name: new string('n', 81))));
    }

    [Fact]
    public void Accepts_a_name_of_exactly_eighty_characters()
    {
        Assert.True(IsValid(Rule(name: new string('n', 80))));
    }

    [Fact]
    public void Accepts_a_hundred_rules()
    {
        Assert.True(IsValid([.. Enumerable.Range(0, 100).Select(i => Rule(id: $"r{i}"))]));
    }

    [Fact]
    public void Refuses_a_hundred_and_one_rules()
    {
        Assert.False(IsValid([.. Enumerable.Range(0, 101).Select(i => Rule(id: $"r{i}"))]));
    }

    // Two rules under one id are one rule to everything downstream: the engine keys its state by
    // (rule, topic), and the second one would silently take the first one's cooldowns and mutes.
    [Fact]
    public void Refuses_two_rules_that_share_an_id()
    {
        Assert.False(IsValid(Rule(id: "6f1d"), Rule(id: "6f1d", name: "Other")));
    }

    // The id is a topic level: the default publish topic is "{prefix}{RuleId}/{topic}". An id with
    // a '/' quietly adds a level to every alarm that rule publishes, and one with a '+' cannot be
    // published at all.
    [Theory]
    [InlineData("a/b")]
    [InlineData("a+b")]
    [InlineData("a#")]
    [InlineData("with space")]
    public void Refuses_an_id_that_could_not_be_a_topic_level(string id)
    {
        Assert.False(IsValid(Rule(id: id)));
    }

    // "condition": null binds without complaint — the serialiser only refuses a type it does not
    // know, not an absent object — so this is the validator's to catch. Built by hand rather than
    // through Rule(), whose `condition ?? threshold` default would put the null back.
    [Fact]
    public void Refuses_a_rule_with_no_condition()
    {
        var rule = new AlertRuleDto("6f1d", "Boiler", Enabled: true, "plant/boiler/temp",
            Field: null, Condition: null!, Clear: null, For: null, Cooldown: null,
            AlertSeverity.Warn, [Screen()]);

        Assert.False(IsValid(rule));
    }

    [Theory]
    [InlineData("(unclosed")]
    [InlineData("[a-")]
    [InlineData("*")]
    public void Refuses_a_pattern_that_does_not_compile(string pattern)
    {
        Assert.False(IsValid(Rule(condition: new PatternCondition(pattern, Negate: false))));
    }

    // Compiled the way CompiledPatterns compiles it — NonBacktracking first, the timed engine
    // second — and this is the pattern that proves the second half is there. A lookbehind makes
    // NonBacktracking throw NotSupportedException; a validator that only tried the linear engine
    // would refuse a legal regex the engine would have run perfectly well.
    [Fact]
    public void Accepts_a_pattern_the_linear_engine_refuses()
    {
        Assert.True(IsValid(Rule(condition: new PatternCondition("^(a+)+$(?<!z)", Negate: false))));
    }

    [Fact]
    public void Refuses_a_pattern_longer_than_the_editor_allows()
    {
        Assert.False(IsValid(Rule(condition: new PatternCondition(new string('a', 251), Negate: false))));
    }

    // The union is a tree and the walk has to be one too. A broken pattern two levels down is a
    // rule that saves, loads, and faults on its first message.
    [Fact]
    public void Refuses_a_broken_pattern_nested_in_a_composite()
    {
        var condition = new AllCondition([
            new ThresholdCondition(ThresholdOp.Gt, 90),
            new AnyCondition([new PatternCondition("(unclosed", Negate: false)])
        ]);

        Assert.False(IsValid(Rule(condition: condition)));
    }

    // 'after: 0' is not a silence rule, it is a rule that fires on every tick for every topic it
    // has ever seen — and the panel would show it as an alerting system having a breakdown.
    [Theory]
    [InlineData(0)]
    [InlineData(-30)]
    public void Refuses_a_silence_that_is_not_a_duration(int after)
    {
        Assert.False(IsValid(Rule(condition: new SilenceCondition(after))));
    }

    // For is 'the condition has held for this long', and silence already is a duration. 'nothing
    // has arrived for 300 seconds, for 30 seconds' has no meaning the engine could implement, and
    // the two numbers would read as one interval to everybody who saw them.
    [Fact]
    public void Refuses_a_For_given_with_a_silence()
    {
        Assert.False(IsValid(Rule(condition: new SilenceCondition(300), forSeconds: 30)));
    }

    [Fact]
    public void Refuses_a_For_given_with_a_silence_inside_a_composite()
    {
        var condition = new AnyCondition([
            new ThresholdCondition(ThresholdOp.Gt, 90),
            new SilenceCondition(300)
        ]);

        Assert.False(IsValid(Rule(condition: condition, forSeconds: 30)));
    }

    [Fact]
    public void Accepts_a_For_on_a_threshold()
    {
        Assert.True(IsValid(Rule(forSeconds: 30, cooldown: 60)));
    }

    [Theory]
    [InlineData(-1, null)]
    [InlineData(null, -1)]
    public void Refuses_a_negative_For_or_Cooldown(int? forSeconds, int? cooldown)
    {
        Assert.False(IsValid(Rule(forSeconds: forSeconds, cooldown: cooldown)));
    }

    // The enum converter refuses an unknown *word*, but a number binds to whatever it says, and a
    // severity of 7 is a row the panel cannot colour and a tone it cannot pick.
    [Fact]
    public void Refuses_a_severity_that_is_not_one_of_the_three()
    {
        Assert.False(IsValid(Rule(severity: (AlertSeverity)7)));
    }

    [Theory]
    [InlineData("telegram")]
    [InlineData("")]
    [InlineData("Screen")]
    public void Refuses_an_unknown_action_type(string type)
    {
        var action = new AlertActionDto(type, null, null, null, null, null, null);

        Assert.False(IsValid(Rule(actions: [action])));
    }

    [Theory]
    [InlineData("http://localhost:1880/alarm")]
    [InlineData("https://hooks.example/services/T/B/x")]
    public void Accepts_an_absolute_http_or_https_url(string url)
    {
        Assert.True(IsValid(Rule(actions: [Webhook(url)])));
    }

    // The last of the four is the one worth naming: credentials in the URL are sent to the
    // endpoint by every redirect and written into every log on the way, and the header map beside
    // it is the place this design put secrets on purpose.
    [Theory]
    [InlineData("ftp://host/alarm")]
    [InlineData("/relative/alarm")]
    [InlineData("not a url")]
    [InlineData("https://user:pw@hooks.example/alarm")]
    public void Refuses_a_url_that_is_not_one(string url)
    {
        Assert.False(IsValid(Rule(actions: [Webhook(url)])));
    }

    [Fact]
    public void Refuses_more_than_ten_headers()
    {
        var headers = Enumerable.Range(0, 11).ToDictionary(i => $"X-{i}", _ => "v", StringComparer.Ordinal);

        Assert.False(IsValid(Rule(actions: [Webhook("http://localhost:1880/alarm", headers)])));
    }

    // A control character in a header is a request-splitting attempt or a copy-paste accident, and
    // there is no telling which — so neither goes out over a socket this server opened.
    [Theory]
    [InlineData("X-Trace", "value\r\nX-Injected: yes")]
    [InlineData("X-Trace", "value\u0000")]
    [InlineData("X-Tra\nce", "value")]
    [InlineData("", "value")]
    public void Refuses_a_header_that_is_malformed(string name, string value)
    {
        var headers = new Dictionary<string, string> { [name] = value };

        Assert.False(IsValid(Rule(actions: [Webhook("http://localhost:1880/alarm", headers)])));
    }

    [Theory]
    [InlineData(65, 4)]
    [InlineData(4, 1025)]
    public void Refuses_a_header_that_is_too_long(int nameLength, int valueLength)
    {
        var headers = new Dictionary<string, string>
        {
            [new string('n', nameLength)] = new string('v', valueLength)
        };

        Assert.False(IsValid(Rule(actions: [Webhook("http://localhost:1880/alarm", headers)])));
    }

    // The redaction's own sentence has to survive its own validator. An empty value is a console
    // saying 'this header, the one you already have', and a rule refused for it could never be
    // saved twice.
    [Fact]
    public void Accepts_a_header_given_with_no_value()
    {
        var headers = new Dictionary<string, string> { ["Authorization"] = "" };

        Assert.True(IsValid(Rule(actions: [Webhook("http://localhost:1880/alarm", headers)])));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    public void Accepts_a_qos_of_zero_one_or_two(int qos)
    {
        Assert.True(IsValid(Rule(actions: [Publish(null, qos)])));
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(3)]
    public void Refuses_a_qos_outside_zero_to_two(int qos)
    {
        Assert.False(IsValid(Rule(actions: [Publish(null, qos)])));
    }

    // Checked after {topic} is expanded, which is the whole point: 'plant/alarms' is obviously
    // outside the tree, but '{topic}/alarm' looks like a template and expands to whatever the
    // plant is publishing — the engine writing back into the very topics it is watching.
    [Theory]
    [InlineData("plant/alarms")]
    [InlineData("{topic}/alarm")]
    [InlineData("mqttforge/alerts")]
    public void Refuses_a_publish_topic_outside_the_prefix(string topic)
    {
        Assert.False(IsValid(Rule(actions: [Publish(topic)])));
    }

    [Theory]
    [InlineData("mqttforge/alerts/{topic}")]
    [InlineData("mqttforge/alerts/boiler")]
    public void Accepts_a_publish_topic_inside_the_prefix(string topic)
    {
        Assert.True(IsValid(Rule(actions: [Publish(topic)])));
    }

    [Theory]
    [InlineData("mqttforge/alerts/+")]
    [InlineData("mqttforge/alerts/#")]
    public void Refuses_a_publish_topic_that_carries_a_wildcard(string topic)
    {
        Assert.False(IsValid(Rule(actions: [Publish(topic)])));
    }

    // The subtlest rule in the file. One rule over 'plant/+/temp' watches twenty boilers; a
    // retained publish to one fixed topic means the twentieth alarm overwrites the nineteenth, and
    // the zero-byte retained message that clears one of them clears the record of all of them.
    // Retained state must have somewhere per topic to live.
    [Fact]
    public void Refuses_a_retained_publish_from_a_wildcard_filter_that_names_one_topic()
    {
        Assert.False(IsValid(Rule(
            filter: "plant/+/temp",
            actions: [Publish("mqttforge/alerts/boiler", retain: true)])));
    }

    // The default topic is "{prefix}{RuleId}/{topic}" and already carries the placeholder, so
    // saying nothing is the safe answer as well as the easy one.
    [Fact]
    public void Accepts_a_retained_publish_from_a_wildcard_filter_on_the_default_topic()
    {
        Assert.True(IsValid(Rule(
            filter: "plant/+/temp",
            actions: [Publish(null, retain: true)])));
    }

    [Fact]
    public void Accepts_a_retained_publish_from_a_wildcard_filter_that_carries_the_placeholder()
    {
        Assert.True(IsValid(Rule(
            filter: "plant/+/temp",
            actions: [Publish("mqttforge/alerts/{topic}", retain: true)])));
    }

    [Fact]
    public void Accepts_a_retained_publish_from_a_filter_with_no_wildcard()
    {
        Assert.True(IsValid(Rule(
            filter: "plant/boiler/temp",
            actions: [Publish("mqttforge/alerts/boiler", retain: true)])));
    }


    // The spec's ranges: window 20..2000, and k means two different things — an interquartile
    // multiplier for tukey, allowed 0.5 to 5, and a count of deviations for sigma, allowed 1 to
    // 10. Nought is not a value in either range; it is how JSON says the member was not given,
    // and the engine's own defaults (1.5 and 3) apply. The second row is the whole of that rule:
    // {"type":"outlier","method":"tukey"} is the shortest honest way to write this condition and
    // it has to stay saveable.
    [Theory]
    [InlineData(OutlierMethod.Tukey, 1.5, 200)]
    [InlineData(OutlierMethod.Tukey, 0, 0)]
    [InlineData(OutlierMethod.Tukey, 0.5, 20)]
    [InlineData(OutlierMethod.Tukey, 5, 2000)]
    [InlineData(OutlierMethod.Sigma, 3, 200)]
    [InlineData(OutlierMethod.Sigma, 1, 20)]
    [InlineData(OutlierMethod.Sigma, 10, 2000)]
    public void Accepts_an_outlier_condition_inside_its_ranges(
        OutlierMethod method, double k, int window)
    {
        Assert.True(IsValid(Rule(condition: new OutlierCondition(method, k, window))));
    }

    [Theory]
    [InlineData(OutlierMethod.Tukey, 1.5, 19)]
    [InlineData(OutlierMethod.Tukey, 1.5, 2001)]
    [InlineData(OutlierMethod.Tukey, 1.5, -1)]
    [InlineData(OutlierMethod.Tukey, 0.4, 200)]
    [InlineData(OutlierMethod.Tukey, 5.1, 200)]
    [InlineData(OutlierMethod.Sigma, 0.9, 200)]
    [InlineData(OutlierMethod.Sigma, 10.1, 200)]
    public void Refuses_an_outlier_condition_outside_them(
        OutlierMethod method, double k, int window)
    {
        Assert.False(IsValid(Rule(condition: new OutlierCondition(method, k, window))));
    }

    // The message names the method, because the two ranges are different and a user who has just
    // been told "k has to be between 1 and 10" while looking at a tukey rule has been told
    // something false about the rule in front of them.
    [Fact]
    public void The_refusal_names_the_method_whose_range_was_missed()
    {
        Assert.Contains(
            "tukey",
            Message(Rule(condition: new OutlierCondition(OutlierMethod.Tukey, 6, 200))));

        Assert.Contains(
            "sigma",
            Message(Rule(condition: new OutlierCondition(OutlierMethod.Sigma, 12, 200))));
    }

    // The union is recursive, so the ranges have to be checked wherever an outlier sits — not
    // only at the root. A composite that carried an unvalidated child would be one 'any' away
    // from every rule in this section being decorative.
    [Fact]
    public void An_outlier_buried_in_a_composite_is_checked_too()
    {
        Assert.False(IsValid(Rule(condition: new AnyCondition([
            new ThresholdCondition(ThresholdOp.Gt, 90),
            new AllCondition([new OutlierCondition(OutlierMethod.Sigma, 0, 5000)])
        ]))));
    }

    // 'for' is 'the condition has held for this long', and these two are not conditions that hold
    // — they are moments. A distribution changes at a cycle boundary and is either the same name
    // as last time or a different one; there is no interval for a duration to be measured over,
    // so a rule carrying both would silently never fire.
    [Fact]
    public void Refuses_a_For_given_with_a_distribution_shift()
    {
        Assert.False(IsValid(Rule(condition: new DistributionShiftCondition(200), forSeconds: 30)));
        Assert.Contains("'for'", Message(Rule(condition: new DistributionShiftCondition(200), forSeconds: 30)));
    }

    // Inside a composite too, exactly as the silence rule is: an edge buried in an 'any' is still
    // an edge, and the rule around it is still one nobody could make hold for thirty seconds.
    [Fact]
    public void Refuses_a_For_given_with_a_shape_change_inside_a_composite()
    {
        var condition = new AnyCondition([new ThresholdCondition(ThresholdOp.Gt, 90), new ShapeChangeCondition(200)]);

        Assert.False(IsValid(Rule(condition: condition, forSeconds: 30)));
    }

    // A pulse is not an edge. 'The period has been over eight seconds for two minutes' is a
    // sentence about a state that holds, and refusing it would take away the one thing that
    // stops a rhythm rule ringing on a single slow cycle.
    [Fact]
    public void Accepts_a_For_given_with_a_pulse()
    {
        var condition = new PulseCondition(PulseMetric.Period, ThresholdOp.Gt, 8000, 200);

        Assert.True(IsValid(Rule(condition: condition, forSeconds: 120)));
    }
}
