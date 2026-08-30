using Microsoft.Extensions.Time.Testing;
using MqttForge.Application.Alerts;
using MqttForge.Application.Services;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;
using MqttForge.UnitTests.Application.Alerts;

namespace MqttForge.UnitTests.Application;

// The engine is a class with no interface, so there is nothing to mock and nothing worth
// pretending: these tests run a real AlertEngine on a real pump and watch what the save did to
// it. That is also the only view the PUT endpoint will ever have, so a test that could see more
// than this would be testing something the product cannot.
public class AlertRuleServiceTests
{
    private static readonly DateTimeOffset Start = new(2026, 8, 30, 9, 0, 0, TimeSpan.Zero);

    private static AlertRule Rule(string id, string filter = "plant/+/temp") =>
        new(id, id, Enabled: true, filter, Field: null, new ThresholdCondition(ThresholdOp.Gt, 90),
            Clear: null, For: null, Cooldown: null, AlertSeverity.Warn, [new ScreenAction()]);

    private sealed class Fixture : IAsyncDisposable
    {
        public FakeTimeProvider Time { get; } = new(Start);
        public FakeAlertRuleStore Store { get; } = new();
        public RecordingSubscriber Subscriber { get; } = new();
        public AlertEngine Engine { get; }
        public AlertRuleService Service { get; }

        private readonly CancellationTokenSource _cancellation = new();
        private readonly Task _pump;

        // StartAsync is deliberately never called: the engine begins knowing nothing, so every
        // rule it ends up holding can only have arrived by being pushed.
        public Fixture()
        {
            Engine = new AlertEngine(
                new AlertEngineCore(new AlertEngineOptions()),
                Store,
                new FakeAlertStateStore(),
                new RecordingAlertNotifier(),
                new FakeConnection { State = ConnectionState.Connected },
                Subscriber,
                new RecordingLogger<AlertEngine>(),
                Time);

            Service = new AlertRuleService(Store, Engine);
            _pump = Task.Run(() => Engine.RunAsync(_cancellation.Token));
        }

        public Task Until(Func<bool> settled, string what) => Eventually.Until(Time, settled, what);

        public async ValueTask DisposeAsync()
        {
            await _cancellation.CancelAsync();
            await _pump;
            _cancellation.Dispose();
        }
    }

    [Fact]
    public async Task GetAsync_hands_back_the_document_the_store_read()
    {
        await using var fixture = new Fixture();
        fixture.Store.Document = new AlertRuleDocument([Rule("a")], Unreadable: false, []);

        var document = await fixture.Service.GetAsync(CancellationToken.None);

        Assert.Equal("a", Assert.Single(document.Rules).Id);
        Assert.False(document.Unreadable);
        Assert.Empty(document.SkippedIds);
    }

    [Fact]
    public async Task GetAsync_carries_the_unreadable_flag_and_the_ids_the_reader_skipped()
    {
        // The document and not a list of rules, because the panel's red row is drawn from exactly
        // these two fields: a caller handed only the rules could not tell an empty file from a
        // broken one, which is the distinction the whole file decision rests on.
        await using var fixture = new Fixture();
        fixture.Store.Document = new AlertRuleDocument([], Unreadable: true, ["#3 'Kiln'"]);

        var document = await fixture.Service.GetAsync(CancellationToken.None);

        Assert.True(document.Unreadable);
        Assert.Equal(["#3 'Kiln'"], document.SkippedIds);
    }

    [Fact]
    public async Task GetAsync_tells_the_engine_nothing()
    {
        await using var fixture = new Fixture();
        fixture.Store.Document = new AlertRuleDocument([Rule("a", "plant/a/#")], Unreadable: false, []);

        await fixture.Service.GetAsync(CancellationToken.None);
        await fixture.Service.ReplaceAsync([Rule("b", "plant/b/#")], discardUnreadable: false,
            CancellationToken.None);

        await fixture.Until(() => fixture.Engine.Snapshot.Rules.Count == 1, "the save arrived");

        // A read is a read. Had GetAsync pushed what it found, 'a' would be sitting in the queue
        // in front of 'b' — and every panel refresh would be a rule-set change, resetting the
        // cooldown of every rule in the file.
        Assert.Equal("b", Assert.Single(fixture.Engine.Snapshot.Rules).RuleId);
    }

    [Fact]
    public async Task ReplaceAsync_writes_the_rules_and_then_tells_the_engine()
    {
        await using var fixture = new Fixture();

        await fixture.Service.ReplaceAsync([Rule("boiler", "plant/+/temp")], discardUnreadable: false,
            CancellationToken.None);

        Assert.Equal(["boiler"], Assert.Single(fixture.Store.Saves).Select(rule => rule.Id));

        await fixture.Until(() => fixture.Engine.Snapshot.Rules.Count == 1, "the rule set reached the engine");

        // The push is the whole mechanism: the engine never re-reads the file on the message path,
        // so the proof it heard about this save is that it went and subscribed the rule's filter.
        Assert.Equal(["plant/+/temp"], Assert.Single(fixture.Subscriber.Batches));
        Assert.Equal("boiler", Assert.Single(fixture.Engine.Snapshot.Rules).RuleId);
    }

    [Fact]
    public async Task Every_save_reaches_the_engine_as_one_rule_set()
    {
        await using var fixture = new Fixture();

        await fixture.Service.ReplaceAsync([Rule("a", "plant/a/#")], false, CancellationToken.None);
        await fixture.Until(() => fixture.Subscriber.Batches.Count == 1, "the first save arrived");

        await fixture.Service.ReplaceAsync([Rule("a", "plant/a/#"), Rule("b", "plant/b/#")], false,
            CancellationToken.None);
        await fixture.Until(() => fixture.Subscriber.Batches.Count == 2, "the second save arrived");

        // The second batch carries only what the second save added, which is the engine diffing
        // one whole rule set against the one it held — not two half-sets, and not the file read
        // twice.
        Assert.Equal(["plant/b/#"], fixture.Subscriber.Batches[1]);
        Assert.Empty(fixture.Subscriber.Unsubscribed);
        Assert.Equal(2, fixture.Store.Saves.Count);
    }

    [Fact]
    public async Task ReplaceAsync_refuses_to_write_over_a_file_nobody_can_read()
    {
        // The spec's "Kural dosyası bir kayıttır". JsonColourRuleStore reads a corrupt file as no
        // rules and is right to, because colours are a preference; doing the same here would let
        // the very next save write the user's whole rule set out of existence.
        await using var fixture = new Fixture();
        fixture.Store.Document = new AlertRuleDocument([], Unreadable: true, []);

        await Assert.ThrowsAsync<AlertRulesUnreadableException>(() =>
            fixture.Service.ReplaceAsync([Rule("a", "plant/a/#")], discardUnreadable: false,
                CancellationToken.None));

        Assert.Empty(fixture.Store.Saves);
    }

    [Fact]
    public async Task A_refused_save_tells_the_engine_nothing()
    {
        await using var fixture = new Fixture();
        fixture.Store.Document = new AlertRuleDocument([], Unreadable: true, []);

        await Assert.ThrowsAsync<AlertRulesUnreadableException>(() =>
            fixture.Service.ReplaceAsync([Rule("refused", "plant/refused/#")], false,
                CancellationToken.None));

        // Proving an absence needs something to wait for, so a save that IS allowed follows it.
        // The channel is first in, first out: had the refused set ever been posted it would be
        // sitting in front of this one and the engine would be holding it now.
        fixture.Store.Document = new AlertRuleDocument([], Unreadable: false, []);
        await fixture.Service.ReplaceAsync([Rule("allowed", "plant/allowed/#")], false,
            CancellationToken.None);

        await fixture.Until(() => fixture.Engine.Snapshot.Rules.Count == 1, "the allowed save arrived");

        Assert.Equal("allowed", Assert.Single(fixture.Engine.Snapshot.Rules).RuleId);
        Assert.Equal(["plant/allowed/#"], Assert.Single(fixture.Subscriber.Batches));
    }

    [Fact]
    public async Task ReplaceAsync_writes_over_an_unreadable_file_when_the_caller_asks_for_it_to_be_discarded()
    {
        // The refusal is a door with a handle on it, not a wall. Somebody whose file a text editor
        // mangled has to be able to say 'I know, replace it' — from the panel, deliberately, once.
        await using var fixture = new Fixture();
        fixture.Store.Document = new AlertRuleDocument([], Unreadable: true, []);

        await fixture.Service.ReplaceAsync([Rule("a", "plant/a/#")], discardUnreadable: true,
            CancellationToken.None);

        Assert.Equal(["a"], Assert.Single(fixture.Store.Saves).Select(rule => rule.Id));

        await fixture.Until(() => fixture.Engine.Snapshot.Rules.Count == 1, "the engine was told about the save");
    }

    [Fact]
    public async Task ReplaceAsync_refuses_when_the_file_holds_a_rule_this_build_could_not_read()
    {
        // The same argument, one rule at a time. A file that loads except for a single condition
        // type this build has never met would otherwise be saved back without that rule — which is
        // deleting it, quietly, on behalf of a user who never saw it.
        //
        // Unreadable is set here as well as the skipped id, and that is not carelessness: it is
        // the only document JsonAlertRuleStore can actually produce. Its LoadAsync ends with
        // `new AlertRuleDocument(rules, skipped.Count > 0, skipped)`, so anything skipped raises
        // both flags at once. A fake with Unreadable false and a skipped id would be a shape the
        // real store never emits, and a test built on it would prove nothing about production.
        // With both up, this test is the one that pins the order: the named rule wins, because
        // "could not be read" is the less useful of the two true sentences.
        await using var fixture = new Fixture();
        fixture.Store.Document = new AlertRuleDocument([Rule("a", "plant/a/#")], Unreadable: true, ["#2 'Kiln'"]);

        var thrown = await Assert.ThrowsAsync<AlertRulesUnreadableException>(() =>
            fixture.Service.ReplaceAsync([Rule("a", "plant/a/#")], false, CancellationToken.None));

        // Named, because "something in your file could not be read" is not something anyone can act on.
        Assert.Contains("#2 'Kiln'", thrown.Message);
        Assert.Empty(fixture.Store.Saves);
    }

    [Fact]
    public async Task ReplaceAsync_writes_past_a_skipped_rule_when_the_caller_asks_for_it_to_be_discarded()
    {
        // The same document the store really emits when it skipped a rule: both flags up.
        await using var fixture = new Fixture();
        fixture.Store.Document = new AlertRuleDocument([Rule("a", "plant/a/#")], Unreadable: true, ["#2 'Kiln'"]);

        await fixture.Service.ReplaceAsync([Rule("a", "plant/a/#")], discardUnreadable: true,
            CancellationToken.None);

        Assert.Equal(["a"], Assert.Single(fixture.Store.Saves).Select(rule => rule.Id));
    }

    [Fact]
    public async Task A_store_that_cannot_write_surfaces_AlertRulesNotSavedException_unchanged()
    {
        await using var fixture = new Fixture();
        fixture.Store.SaveFault =
            new AlertRulesNotSavedException("Could not save the alert rules: the volume is read-only.");

        var thrown = await Assert.ThrowsAsync<AlertRulesNotSavedException>(() =>
            fixture.Service.ReplaceAsync([Rule("a", "plant/a/#")], false, CancellationToken.None));

        // Unchanged: not wrapped, not translated. AlertRulesNotSavedException exists so the user
        // is told "could not save the alert rules" rather than a sentence about a colour panel
        // they never opened — and it is not yet in MqttExceptionHandler's switch, so wrapping it
        // here would destroy the only thing the endpoint task has left to map.
        Assert.Contains("read-only", thrown.Message);
    }

    [Fact]
    public async Task A_write_that_failed_tells_the_engine_nothing()
    {
        await using var fixture = new Fixture();
        fixture.Store.SaveFault =
            new AlertRulesNotSavedException("Could not save the alert rules: the volume is read-only.");

        await Assert.ThrowsAsync<AlertRulesNotSavedException>(() =>
            fixture.Service.ReplaceAsync([Rule("lost", "plant/lost/#")], false, CancellationToken.None));

        // The file and the engine agree or they do not: an engine running a rule set that is
        // nowhere on disk would come back from the next restart as a different product.
        fixture.Store.SaveFault = null;
        await fixture.Service.ReplaceAsync([Rule("kept", "plant/kept/#")], false, CancellationToken.None);

        await fixture.Until(() => fixture.Engine.Snapshot.Rules.Count == 1, "the save that worked arrived");

        Assert.Equal("kept", Assert.Single(fixture.Engine.Snapshot.Rules).RuleId);
        Assert.Equal(["plant/kept/#"], Assert.Single(fixture.Subscriber.Batches));
    }

    [Fact]
    public async Task Saving_an_empty_list_is_a_save_like_any_other_and_takes_the_subscriptions_down()
    {
        // Deleting the last rule is a thing people do, and an empty list is how the panel says it.
        // Refusing it — reading 'no rules' as 'you must have meant something else' — would leave a
        // user with an alarm they cannot switch off.
        await using var fixture = new Fixture();

        await fixture.Service.ReplaceAsync([Rule("a", "plant/a/#")], false, CancellationToken.None);
        await fixture.Until(() => fixture.Subscriber.Filters.Count == 1, "the rule's filter went up");

        await fixture.Service.ReplaceAsync([], false, CancellationToken.None);
        await fixture.Until(() => fixture.Subscriber.Unsubscribed.Count == 1, "the filter came back down");

        Assert.Equal(2, fixture.Store.Saves.Count);
        Assert.Empty(fixture.Store.Saves[1]);
        Assert.Equal(["plant/a/#"], fixture.Subscriber.Unsubscribed);
    }
}
