using System.Text.Json;
using MqttForge.Application.Alerts;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Persistence;
using Xunit;

namespace MqttForge.UnitTests.Infrastructure;

public class JsonAlertRuleStoreTests : IDisposable
{
    private readonly string _path = Path.Combine(Path.GetTempPath(), $"mqttforge-{Guid.NewGuid():N}.json");

    // The store's own options rather than a second copy of them, and deliberately so. A private
    // copy here would agree with the writer today and follow nothing tomorrow: the day someone
    // changes how the file is written, the comparison below would go on passing while the file on
    // disk drifted away from web/src/types/api.ts. Task 4 already pins AlertRuleJson.Options
    // against the wire's own options, so borrowing them here borrows that pin as well.
    private static readonly JsonSerializerOptions Wire = AlertRuleJson.Options;

    private static AlertRule Rule(string id) =>
        new(id, "Boiler temperature", true, "plant/+/temp", "$.temp",
            new ThresholdCondition(ThresholdOp.Gt, 90), null, null, null,
            AlertSeverity.Critical, [new ScreenAction()]);

    [Fact]
    public async Task Load_returns_no_rules_and_calls_a_missing_file_readable()
    {
        var store = new JsonAlertRuleStore(_path);

        var document = await store.LoadAsync(CancellationToken.None);

        Assert.Empty(document.Rules);
        Assert.Empty(document.SkippedIds);
        // A first run has no file and nothing to protect. Calling this unreadable would lock
        // every new install out of saving its first rule.
        Assert.False(document.Unreadable);
    }

    [Fact]
    public async Task Save_then_Load_returns_the_same_rules()
    {
        var store = new JsonAlertRuleStore(_path);
        IReadOnlyList<AlertRule> rules =
        [
            new("r1", "Boiler temperature", true, "plant/+/temp", "$.temp",
                new ThresholdCondition(ThresholdOp.Gt, 90),
                new ThresholdCondition(ThresholdOp.Lt, 85),
                30, 60, AlertSeverity.Critical,
                [
                    new ScreenAction(),
                    new WebhookAction("http://example.test/hook",
                        new Dictionary<string, string> { ["X-Token"] = "secret" })
                ]),
            // A 4-20mA line pinned at the top of its range, written as a composite so the round
            // trip has to rebuild a tree and not just a leaf.
            new("r2", "Level line stuck at the top", true, "plant/tank/level", null,
                new AllCondition(
                [
                    new ThresholdCondition(ThresholdOp.Gte, 20.0),
                    new AnyCondition(
                    [
                        new PatternCondition("^ok$", true),
                        new OneOfCondition(["stale", "frozen"], false)
                    ]),
                    new BandCondition(3.9, 20.1, false)
                ]),
                null, null, null, AlertSeverity.Warn,
                [new PublishAction(null, 1, true)]),
            new("r3", "Nothing from the vibration probe", false, "plant/pump/vibration", null,
                new SilenceCondition(300), null, null, 1, AlertSeverity.Info, [new SoundAction()])
        ];

        await store.SaveAsync(rules, CancellationToken.None);
        var document = await store.LoadAsync(CancellationToken.None);

        Assert.False(document.Unreadable);
        Assert.Empty(document.SkippedIds);
        // AlertRule's record equality stops at the references its Actions list carries, and so
        // does AllCondition's, so the two sets are compared as the text they are meant to be.
        Assert.Equal(
            JsonSerializer.Serialize(rules, Wire),
            JsonSerializer.Serialize(document.Rules, Wire));

        // And the tree is really a tree of the derived types, not something that survived the
        // comparison above by being wrong in both directions.
        var composite = Assert.IsType<AllCondition>(document.Rules[1].Condition);
        Assert.Equal(3, composite.Of.Count);
        Assert.Equal(new ThresholdCondition(ThresholdOp.Gte, 20.0), composite.Of[0]);
        var either = Assert.IsType<AnyCondition>(composite.Of[1]);
        Assert.Equal(new PatternCondition("^ok$", true), either.Of[0]);
        Assert.Equal(["stale", "frozen"], Assert.IsType<OneOfCondition>(either.Of[1]).Values);
        Assert.Equal(new BandCondition(3.9, 20.1, false), composite.Of[2]);
    }

    [Fact]
    public async Task Save_writes_the_envelope_and_the_discriminators()
    {
        var store = new JsonAlertRuleStore(_path);

        await store.SaveAsync([Rule("r1")], CancellationToken.None);

        using var written = JsonDocument.Parse(await File.ReadAllTextAsync(_path));
        Assert.Equal(1, written.RootElement.GetProperty("version").GetInt32());
        var rule = written.RootElement.GetProperty("rules")[0];
        Assert.Equal("r1", rule.GetProperty("id").GetString());
        Assert.Equal("plant/+/temp", rule.GetProperty("filter").GetString());
        Assert.Equal("$.temp", rule.GetProperty("field").GetString());
        Assert.Equal("critical", rule.GetProperty("severity").GetString());
        Assert.Equal("threshold", rule.GetProperty("condition").GetProperty("type").GetString());
        Assert.Equal("gt", rule.GetProperty("condition").GetProperty("op").GetString());
        Assert.Equal(90, rule.GetProperty("condition").GetProperty("value").GetDouble());
        Assert.Equal("screen", rule.GetProperty("actions")[0].GetProperty("type").GetString());
    }

    // A record, not a preference: counting a broken file as "no rules" turns every alarm off in
    // silence, and the next save deletes what the user wrote.
    [Fact]
    public async Task Load_calls_a_corrupt_file_unreadable()
    {
        await File.WriteAllTextAsync(_path, "{ not json");
        var store = new JsonAlertRuleStore(_path);

        var document = await store.LoadAsync(CancellationToken.None);

        Assert.True(document.Unreadable);
        Assert.Empty(document.Rules);
        Assert.Empty(document.SkippedIds);
    }

    // A write that died between File.Create and the first byte. It parses as nothing at all.
    [Fact]
    public async Task Load_calls_an_empty_file_unreadable()
    {
        await File.WriteAllTextAsync(_path, "");
        var store = new JsonAlertRuleStore(_path);

        Assert.True((await store.LoadAsync(CancellationToken.None)).Unreadable);
    }

    [Fact]
    public async Task Load_calls_a_newer_envelope_version_unreadable()
    {
        await File.WriteAllTextAsync(_path, """{ "version": 2, "rules": [] }""");
        var store = new JsonAlertRuleStore(_path);

        var document = await store.LoadAsync(CancellationToken.None);

        // Version 2 was written by a build that knew something this one does not. Running with
        // no rules is bad; saving over it is worse.
        Assert.True(document.Unreadable);
        Assert.Empty(document.Rules);
    }

    [Fact]
    public async Task Load_calls_a_file_without_the_envelope_unreadable()
    {
        // The shape colour-rules.json has, and the shape someone hand-writing this file guesses.
        await File.WriteAllTextAsync(_path, """[ { "id": "r1" } ]""");
        var store = new JsonAlertRuleStore(_path);

        Assert.True((await store.LoadAsync(CancellationToken.None)).Unreadable);
    }

    [Fact]
    public async Task Load_returns_a_readable_document_for_an_empty_rule_array()
    {
        await File.WriteAllTextAsync(_path, """{ "version": 1, "rules": [] }""");
        var store = new JsonAlertRuleStore(_path);

        var document = await store.LoadAsync(CancellationToken.None);

        // Someone deleted their last rule. That is a state, not a fault, and saving is allowed.
        Assert.False(document.Unreadable);
        Assert.Empty(document.Rules);
    }

    [Fact]
    public async Task Load_keeps_the_rules_it_understood_and_names_the_one_it_did_not()
    {
        await File.WriteAllTextAsync(_path, """
        { "version": 1,
          "rules": [
            { "id": "good", "name": "Boiler temperature", "enabled": true,
              "filter": "plant/+/temp", "field": "$.temp",
              "condition": { "type": "threshold", "op": "gt", "value": 90 },
              "severity": "critical", "actions": [ { "type": "screen" } ] },
            { "id": "future", "name": "Written by a newer build", "enabled": true,
              "filter": "plant/#",
              "condition": { "type": "entropy", "window": 200 },
              "severity": "warn", "actions": [ { "type": "screen" } ] } ] }
        """);
        var store = new JsonAlertRuleStore(_path);

        var document = await store.LoadAsync(CancellationToken.None);

        Assert.Equal("good", Assert.Single(document.Rules).Id);
        // The optional members the file left out came back as absent, not as noise.
        Assert.Null(document.Rules[0].Clear);
        Assert.Null(document.Rules[0].For);
        Assert.Null(document.Rules[0].Cooldown);
        Assert.Equal("future", Assert.Single(document.SkippedIds));
        // Rules to run AND unreadable: the engine gets what it can judge, and a save is refused
        // because writing this list back would delete the rule nobody here understood.
        Assert.True(document.Unreadable);
    }

    [Fact]
    public async Task Load_names_a_skipped_rule_by_its_position_when_it_has_no_id()
    {
        await File.WriteAllTextAsync(_path, """
        { "version": 1,
          "rules": [
            { "name": "No id, no condition anyone knows", "enabled": true, "filter": "a/#",
              "condition": { "type": "entropy" }, "severity": "warn", "actions": [] } ] }
        """);
        var store = new JsonAlertRuleStore(_path);

        var document = await store.LoadAsync(CancellationToken.None);

        // The panel has to point at something, and where it sits is the only handle left.
        Assert.Equal("rule 1", Assert.Single(document.SkippedIds));
        Assert.True(document.Unreadable);
    }

    [Fact]
    public async Task Load_skips_a_rule_that_is_not_even_an_object()
    {
        await File.WriteAllTextAsync(_path, """
        { "version": 1,
          "rules": [
            null,
            42,
            { "id": "good", "name": "Boiler temperature", "enabled": true,
              "filter": "plant/+/temp", "field": "$.temp",
              "condition": { "type": "threshold", "op": "gt", "value": 90 },
              "severity": "critical", "actions": [ { "type": "screen" } ] } ] }
        """);
        var store = new JsonAlertRuleStore(_path);

        var document = await store.LoadAsync(CancellationToken.None);

        Assert.Equal("good", Assert.Single(document.Rules).Id);
        Assert.Equal(["rule 1", "rule 2"], document.SkippedIds);
        Assert.True(document.Unreadable);
    }

    // The validator never saw this rule: it arrived by someone editing the file. A pattern that
    // will not build must fail here and not on the first message that reaches the engine.
    [Fact]
    public async Task Load_skips_a_rule_whose_pattern_will_not_compile()
    {
        await File.WriteAllTextAsync(_path, """
        { "version": 1,
          "rules": [
            { "id": "broken", "name": "Unclosed group", "enabled": true, "filter": "a/#",
              "condition": { "type": "pattern", "regex": "(unclosed", "negate": false },
              "severity": "warn", "actions": [ { "type": "screen" } ] } ] }
        """);
        var store = new JsonAlertRuleStore(_path);

        var document = await store.LoadAsync(CancellationToken.None);

        Assert.Empty(document.Rules);
        Assert.Equal("broken", Assert.Single(document.SkippedIds));
        Assert.True(document.Unreadable);
    }

    [Fact]
    public async Task Save_creates_the_directory()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"mqttforge-{Guid.NewGuid():N}");
        var nested = Path.Combine(directory, "alert-rules.json");
        var store = new JsonAlertRuleStore(nested);

        try
        {
            await store.SaveAsync([Rule("r1")], CancellationToken.None);

            Assert.True(File.Exists(nested));
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task Save_leaves_the_old_file_intact_when_the_write_fails()
    {
        var store = new JsonAlertRuleStore(_path);
        await store.SaveAsync([Rule("first")], CancellationToken.None);

        // A directory sitting where the temp file wants to be: File.Create is refused on every
        // platform, and it is refused at exactly the moment an interrupted write would die —
        // after the old file was found, before anything replaced it.
        Directory.CreateDirectory(_path + ".tmp");

        await Assert.ThrowsAsync<AlertRulesNotSavedException>(() =>
            store.SaveAsync([Rule("second")], CancellationToken.None));

        var document = await store.LoadAsync(CancellationToken.None);
        Assert.False(document.Unreadable);
        Assert.Equal("first", Assert.Single(document.Rules).Id);
    }

    // ThrowsAsync is exact on the type, so this also pins that the colour rules' exception is
    // not reused: it would tell the user their colour rules could not be saved.
    [Fact]
    public async Task Save_onto_something_unwritable_says_the_alert_rules_were_not_saved()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"mqttforge-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        var store = new JsonAlertRuleStore(directory);

        try
        {
            var thrown = await Assert.ThrowsAsync<AlertRulesNotSavedException>(() =>
                store.SaveAsync([Rule("r1")], CancellationToken.None));

            Assert.Contains(directory, thrown.Message);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
            if (File.Exists(directory + ".tmp")) File.Delete(directory + ".tmp");
        }
    }

    public void Dispose()
    {
        if (File.Exists(_path)) File.Delete(_path);
        if (File.Exists(_path + ".tmp")) File.Delete(_path + ".tmp");
        if (Directory.Exists(_path + ".tmp")) Directory.Delete(_path + ".tmp", recursive: true);
    }
}
