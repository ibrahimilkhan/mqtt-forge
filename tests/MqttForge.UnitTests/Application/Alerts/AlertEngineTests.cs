using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;
using MqttForge.Application.Alerts;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Alerts;

// The core's own tests never start a thread: it has no clock and the instant is an argument.
// These do the opposite job — they are about the transport, so the pump really runs, on a real
// thread, with a fake clock the test moves by hand. Everything here waits on an observable state
// with a deadline rather than sleeping for a guessed number of milliseconds.
public class AlertEngineTests
{
    private static readonly DateTimeOffset Start = new(2026, 8, 30, 9, 0, 0, TimeSpan.Zero);

    private static AlertCondition Over90 => new ThresholdCondition(ThresholdOp.Gt, 90);

    private static AlertRule Rule(string id, string filter, AlertCondition condition, bool enabled = true) =>
        new(id, id, enabled, filter, Field: null, condition, Clear: null, For: null, Cooldown: null,
            AlertSeverity.Warn, [new ScreenAction()]);

    private static AlertRuleDocument Document(IReadOnlyList<AlertRule> rules) =>
        new(rules, Unreadable: false, []);

    private static MqttMessage Message(string topic, string payload) =>
        new(topic, payload, "text", 0, false, Start);

    private sealed class Harness : IAsyncDisposable
    {
        public required FakeTimeProvider Time { get; init; }
        public required FakeAlertRuleStore Rules { get; init; }
        public required FakeAlertStateStore State { get; init; }
        public required RecordingAlertNotifier Notifier { get; init; }
        public required FakeConnection Connection { get; init; }
        public required RecordingSubscriber Subscriber { get; init; }
        public required RecordingLogger<AlertEngine> Log { get; init; }
        public required AlertEngine Engine { get; init; }

        private CancellationTokenSource? _cancellation;
        private Task? _pump;

        /// <summary>Starts the loop on a thread of its own, the way AlertEngineHost will.</summary>
        public void Run()
        {
            _cancellation = new CancellationTokenSource();
            _pump = Task.Run(() => Engine.RunAsync(_cancellation.Token));
        }

        public Task Until(Func<bool> settled, string what) => Eventually.Until(Time, settled, what);

        /// <summary>Moves the clock through whole ticks the pump is meant to notice nothing in.</summary>
        public async Task TickAsync(int seconds)
        {
            for (var i = 0; i < seconds; i++)
            {
                Time.Advance(TimeSpan.FromSeconds(1));
                await Task.Delay(10);
            }
        }

        public async ValueTask DisposeAsync()
        {
            if (_cancellation is null || _pump is null) return;

            await _cancellation.CancelAsync();

            // Awaited rather than abandoned, and that is an assertion: a pump that faulted on any
            // turn of any test in this file fails that test here rather than dying in silence.
            await _pump;
            _cancellation.Dispose();
        }
    }

    private static Harness Build(
        AlertRuleDocument? rules = null,
        ConnectionState state = ConnectionState.Connected)
    {
        var time = new FakeTimeProvider(Start);
        var ruleStore = new FakeAlertRuleStore { Document = rules ?? new AlertRuleDocument([], false, []) };
        var stateStore = new FakeAlertStateStore();
        var notifier = new RecordingAlertNotifier();
        var connection = new FakeConnection { State = state };
        var subscriber = new RecordingSubscriber();
        var log = new RecordingLogger<AlertEngine>();

        var engine = new AlertEngine(
            new AlertEngineCore(new AlertEngineOptions()),
            ruleStore, stateStore, notifier, connection, subscriber, log, time);

        return new Harness
        {
            Time = time,
            Rules = ruleStore,
            State = stateStore,
            Notifier = notifier,
            Connection = connection,
            Subscriber = subscriber,
            Log = log,
            Engine = engine,
        };
    }

    [Fact]
    public async Task An_arrival_posted_to_the_queue_is_judged_by_the_core()
    {
        await using var harness = Build(Document([Rule("boiler", "plant/+/temp", Over90)]));
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Run();

        harness.Engine.Post(new ArrivalCommand(Message("plant/boiler/temp", "94.2")));

        await harness.Until(() => harness.Notifier.Raised.Count == 1, "the alarm reached the notifier");

        var alert = Assert.Single(harness.Notifier.Raised);
        Assert.Equal("boiler", alert.RuleId);
        Assert.Equal("plant/boiler/temp", alert.Topic);
        Assert.Equal("plant/boiler/temp", Assert.Single(harness.Engine.Snapshot.Active).Topic);
    }

    [Fact]
    public async Task NotifyMessageReceivedAsync_comes_straight_back_and_the_message_is_judged_later()
    {
        await using var harness = Build(Document([Rule("boiler", "plant/+/temp", Over90)]));
        await harness.Engine.StartAsync(CancellationToken.None);

        // The pump is deliberately not running yet. This is the call MQTTnet's own receive loop
        // makes, and holding that thread up is how a slow rule set becomes a dropped broker link.
        var handed = harness.Engine.NotifyMessageReceivedAsync(Message("plant/boiler/temp", "94.2"));

        Assert.True(handed.IsCompletedSuccessfully);

        harness.Run();

        await harness.Until(() => harness.Notifier.Raised.Count == 1, "the queued message was judged");
    }

    [Fact]
    public async Task A_full_queue_drops_the_oldest_and_the_count_reaches_the_core_and_the_snapshot()
    {
        await using var harness = Build();
        await harness.Engine.StartAsync(CancellationToken.None);

        // Forty thousand into a queue of 32 768, with nothing draining it. Post never blocks, so
        // the excess goes over the front — and the whole bargain is that it is counted.
        const int posted = 40_000;
        for (var i = 0; i < posted; i++)
            harness.Engine.Post(new ArrivalCommand(Message($"noise/{i}", "1")));

        var expected = posted - AlertEngine.QueueCapacity;
        Assert.Equal(expected, harness.Engine.Dropped);

        harness.Run();

        await harness.Until(
            () => harness.Engine.Snapshot.Dropped == expected && harness.Notifier.Dropped == expected,
            "the drop total reached the core, the snapshot and the notifier");

        // Announced on a change only. An engine that is keeping up says nothing at all, which is
        // exactly what messagesDropped does for the console.
        Assert.Equal(1, harness.Notifier.DropCalls);
    }

    [Fact]
    public async Task The_tick_fires_with_nothing_at_all_in_the_queue()
    {
        // The test a pump shaped like SignalRMessageNotifier's — while (await WaitToReadAsync) —
        // cannot pass. Nothing is posted here, ever: that loop would sit in its wait for the whole
        // ten seconds and this rule would never ring. Silence is the reason the tick is a branch
        // of the loop rather than a reaction to a message.
        await using var harness = Build(Document([Rule("dead", "plant/boiler/temp", new SilenceCondition(30))]));
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Run();

        await harness.Until(() => harness.Notifier.Raised.Count == 1, "silence rang with an empty queue");

        var alert = Assert.Single(harness.Notifier.Raised);
        Assert.Equal("plant/boiler/temp", alert.Topic);
        Assert.Empty(harness.Notifier.Resolved);
    }

    [Fact]
    public async Task A_tick_that_changes_nothing_does_not_subscribe_anything_again()
    {
        await using var harness = Build(Document([Rule("boiler", "plant/+/temp", Over90)]));
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Run();

        await harness.TickAsync(5);

        // The arrival is the proof the pump really was awake through those five seconds; without
        // it this test would pass just as well against a loop that had died.
        harness.Engine.Post(new ArrivalCommand(Message("plant/boiler/temp", "94.2")));
        await harness.Until(() => harness.Notifier.Raised.Count == 1, "the pump was awake all along");

        // A diff, not a refresh. Re-sending the same SUBSCRIBE every second would make every
        // broker replay every retained value in the tree once a second.
        Assert.Single(harness.Subscriber.Batches);
        Assert.Empty(harness.Subscriber.Unsubscribed);
    }

    [Fact]
    public async Task StartAsync_subscribes_every_enabled_rule_filter_in_one_batch()
    {
        await using var harness = Build(Document(
        [
            Rule("a", "plant/a/#", Over90),
            Rule("b", "plant/b/#", Over90, enabled: false),
            Rule("c", "plant/c/#", Over90),
        ]));

        await harness.Engine.StartAsync(CancellationToken.None);

        // One packet for the lot: the round trip is what costs, not the filters in it.
        var batch = Assert.Single(harness.Subscriber.Batches);
        Assert.Equal(["plant/a/#", "plant/c/#"], batch.Order());

        // And they go up as the engine's own, so the Filters panel can mark them and refuse to
        // offer a remove button for something only the rule set may take down.
        var held = Assert.Single(harness.Subscriber.Filters, filter => filter.Filter == "plant/a/#");
        Assert.Equal(SubscriptionOwner.Rules, held.Owners);
    }

    [Fact]
    public async Task Two_rules_watching_the_same_filter_are_one_subscription()
    {
        await using var harness = Build(Document(
        [
            Rule("hot", "plant/+/temp", Over90),
            Rule("cold", "plant/+/temp", new ThresholdCondition(ThresholdOp.Lt, 5)),
        ]));

        await harness.Engine.StartAsync(CancellationToken.None);

        // A set, not a list. Two rules on one filter is the ordinary way to write a high and a low
        // alarm, and subscribing twice would have the broker send every message twice.
        Assert.Equal(["plant/+/temp"], Assert.Single(harness.Subscriber.Batches));
    }

    [Fact]
    public async Task A_new_rule_set_subscribes_what_arrived_and_unsubscribes_what_went()
    {
        await using var harness = Build(Document([Rule("a", "plant/a/#", Over90), Rule("b", "plant/b/#", Over90)]));
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Run();

        harness.Engine.Post(new RuleSetChangedCommand(
            [Rule("b", "plant/b/#", Over90), Rule("c", "plant/c/#", Over90)]));

        await harness.Until(() => harness.Subscriber.Batches.Count == 2, "the new filter went up");

        // Only the difference. 'plant/b/#' is already held and is not asked for a second time.
        Assert.Equal(["plant/c/#"], harness.Subscriber.Batches[1]);
        Assert.Equal(["plant/a/#"], harness.Subscriber.Unsubscribed);
        Assert.Equal(["plant/b/#", "plant/c/#"],
            harness.Subscriber.Filters.Select(filter => filter.Filter).Order());
    }

    [Fact]
    public async Task Nothing_is_subscribed_while_the_link_is_down()
    {
        await using var harness = Build(Document([Rule("a", "plant/a/#", Over90)]), ConnectionState.Disconnected);

        await harness.Engine.StartAsync(CancellationToken.None);

        // Subscribing on a dead client throws NotConnectedException, and a start that threw would
        // take the host down over a broker that happens to be rebooting.
        Assert.Empty(harness.Subscriber.Batches);
    }

    [Fact]
    public async Task A_link_that_comes_back_is_given_the_rule_subscriptions_again()
    {
        await using var harness = Build(Document([Rule("a", "plant/a/#", Over90)]));
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Run();

        Assert.Single(harness.Subscriber.Batches);

        // What actually happens on a dropped socket: MqttnetSubscriber clears its filter set and
        // nobody tells the engine. Whoever brings them back has to be written down, and it is here.
        harness.Connection.State = ConnectionState.Disconnected;
        harness.Subscriber.LinkDropped();

        await harness.TickAsync(3);
        Assert.Single(harness.Subscriber.Batches);

        harness.Connection.State = ConnectionState.Connected;

        await harness.Until(() => harness.Subscriber.Batches.Count == 2, "the rule filters went back up");

        Assert.Equal(["plant/a/#"], harness.Subscriber.Batches[1]);
    }

    [Fact]
    public async Task A_filter_the_broker_refuses_is_tried_again_on_a_later_turn()
    {
        await using var harness = Build(Document([Rule("a", "plant/a/#", Over90)]));
        harness.Subscriber.Refuse = new MessageRejectedException("The broker refused 'plant/a/#'.");

        // A refusal is the broker's answer, not a fault in the engine: StartAsync comes back.
        await harness.Engine.StartAsync(CancellationToken.None);

        // Asserted before the pump starts. The flag is left set so the next turn tries again, and
        // every one of those turns adds a batch — counting them after Run() would be counting a
        // race rather than the one attempt StartAsync made.
        Assert.Single(harness.Subscriber.Batches);
        Assert.Contains(harness.Log.Lines, line => line.Level == LogLevel.Warning);

        harness.Run();
        harness.Subscriber.Refuse = null;

        await harness.Until(() => harness.Subscriber.Filters.Count == 1, "the filter went up on a later turn");
    }

    [Fact]
    public async Task An_unreadable_rules_file_starts_the_engine_with_no_rules_at_all_and_says_so()
    {
        await using var harness = Build(new AlertRuleDocument([], Unreadable: true, []));

        await harness.Engine.StartAsync(CancellationToken.None);

        // Zero rules, loudly. The spec's whole point about the file being a record is that this
        // state has to be visible: an Error in the log, a red row in the panel, and a PUT refused.
        Assert.Empty(harness.Engine.Snapshot.Rules);
        Assert.Empty(harness.Subscriber.Batches);
        Assert.Contains(harness.Log.Lines, line => line.Level == LogLevel.Error);
    }

    [Fact]
    public async Task StartAsync_restores_the_state_after_the_rules_and_ends_an_alarm_no_rule_covers()
    {
        var stale = new Alert("old", "gone", "A rule somebody deleted", "plant/ghost/temp",
            AlertSeverity.Warn, Start, Start, ResolvedAt: null, ResolvedBy: null, MutedUntil: null,
            Count: 1, "94.2 > 90", 94.2, "94.2", []);

        await using var harness = Build(Document([Rule("a", "plant/a/#", Over90)]));
        harness.State.Stored = new AlertState([stale], [], []);

        await harness.Engine.StartAsync(CancellationToken.None);

        // The order is the assertion. SetRules ran first, so Restore had a rule set to reconcile
        // against — and the only rule the hand-over file names is not in it, so the alarm goes out
        // instead of coming back. The other way round, the endpoint keeps an alarm for ever.
        var resolved = Assert.Single(harness.Notifier.Resolved);
        Assert.Equal("gone", resolved.RuleId);
        Assert.Equal("rule removed", resolved.ResolvedBy);
        Assert.Empty(harness.Engine.Snapshot.Active);
    }

    [Fact]
    public async Task StartAsync_carries_on_when_there_is_nothing_to_restore()
    {
        await using var harness = Build(Document([Rule("a", "plant/a/#", Over90)]));
        harness.State.Stored = null;

        await harness.Engine.StartAsync(CancellationToken.None);

        // Every first run in the world takes this path, and it must not look like a fault.
        Assert.Empty(harness.Notifier.Resolved);
        Assert.Single(harness.Subscriber.Batches);
    }

    [Fact]
    public async Task StartAsync_carries_on_when_the_state_file_cannot_be_read()
    {
        await using var harness = Build(Document([Rule("a", "plant/a/#", Over90)]));
        harness.State.LoadFault = new IOException("alert-state.json is a directory");

        await harness.Engine.StartAsync(CancellationToken.None);

        // A hand-over, not a record: losing it costs one round of resolved bodies, and refusing to
        // start over it would cost every alert the rules would have caught from now on.
        Assert.Contains(harness.Log.Lines, line => line.Level == LogLevel.Error);
        Assert.Single(harness.Subscriber.Batches);
    }

    [Fact]
    public async Task The_engine_writes_its_state_after_a_change_and_not_again_while_nothing_changes()
    {
        await using var harness = Build(Document([Rule("boiler", "plant/+/temp", Over90)]));
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Run();

        harness.Engine.Post(new ArrivalCommand(Message("plant/boiler/temp", "94.2")));

        await harness.Until(() => harness.State.Saves.Count == 1, "the ringing alarm was written down");

        var saved = Assert.Single(harness.State.Saves);
        Assert.Equal("plant/boiler/temp", Assert.Single(saved.Active).Topic);

        // Ten seconds of ticks with nothing to report. A file written every second whether or not
        // anything moved is a container writing to a mounted volume all day for no reason.
        await harness.TickAsync(10);

        Assert.Single(harness.State.Saves);
    }

    [Fact]
    public async Task A_notifier_that_throws_does_not_take_the_pump_down()
    {
        await using var harness = Build(Document([Rule("boiler", "plant/+/temp", Over90)]));
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Run();

        harness.Notifier.Throw = true;
        harness.Engine.Post(new ArrivalCommand(Message("plant/boiler/temp", "94.2")));

        await harness.Until(() => harness.Engine.Snapshot.Active.Count == 1,
            "the alarm was raised even though the telling failed");

        // Delivery is downstream of judging. A webhook endpoint that has gone away must not stop
        // the engine noticing the next thing that goes wrong.
        harness.Notifier.Throw = false;
        harness.Engine.Post(new ArrivalCommand(Message("plant/kiln/temp", "99")));

        await harness.Until(() => harness.Notifier.Raised.Count == 1, "the pump was still there for the second");

        Assert.Equal("plant/kiln/temp", Assert.Single(harness.Notifier.Raised).Topic);
    }

    [Fact]
    public async Task A_mute_posted_to_the_queue_reaches_the_pair()
    {
        await using var harness = Build(Document([Rule("boiler", "plant/+/temp", Over90)]));
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Run();

        harness.Engine.Post(new ArrivalCommand(Message("plant/boiler/temp", "94.2")));
        await harness.Until(() => harness.Engine.Snapshot.Active.Count == 1, "there is a pair to mute");

        // From the Kestrel thread, through the same channel as an arrival. The controller never
        // touches the core's state — that is what makes the core lock-free.
        harness.Engine.Post(new MuteCommand("boiler", "plant/boiler/temp", 15));

        await harness.Until(() => harness.Engine.Snapshot.Muted.Count == 1, "the mute reached the core");

        var muted = Assert.Single(harness.Engine.Snapshot.Muted);
        Assert.Equal("boiler", muted.RuleId);
        Assert.Equal("plant/boiler/temp", muted.Topic);
        Assert.True(muted.Until > Start);
    }

    [Fact]
    public async Task A_rule_set_that_drops_a_ringing_rule_resolves_it_and_ClearHistory_empties_the_record()
    {
        await using var harness = Build(Document([Rule("boiler", "plant/+/temp", Over90)]));
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Run();

        harness.Engine.Post(new ArrivalCommand(Message("plant/boiler/temp", "94.2")));
        await harness.Until(() => harness.Engine.Snapshot.Active.Count == 1, "the alarm is ringing");

        harness.Engine.Post(new RuleSetChangedCommand([]));

        await harness.Until(() => harness.Notifier.Resolved.Count == 1, "the save ended it");

        // SetRules is the only place this resolution can come from — no message will ever reach
        // that pair again — and the pump has to carry the body out.
        Assert.Equal("rule removed", Assert.Single(harness.Notifier.Resolved).ResolvedBy);
        Assert.Single(harness.Engine.Snapshot.History);
        Assert.Empty(harness.Engine.Snapshot.Active);
        Assert.Equal(["plant/+/temp"], harness.Subscriber.Unsubscribed);

        harness.Engine.Post(new ClearHistoryCommand());

        await harness.Until(() => harness.Engine.Snapshot.History.Count == 0, "the history was cleared");
    }

    [Fact]
    public async Task Posting_from_many_threads_while_the_pump_runs_loses_nothing_and_corrupts_nothing()
    {
        // The real concurrency test, and it is worth saying what it is guarding. The core is a
        // handful of plain Dictionaries with no lock anywhere in them: two threads inside one at
        // the same time do not produce a wrong number, they produce a corrupted table or a loop
        // that never ends. What stops that is that only the pump ever touches it — everyone else
        // posts — and this is the test that says so.
        await using var harness = Build(Document(
            [Rule("all", "plant/#", new ThresholdCondition(ThresholdOp.Gt, 1e9))]));

        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Run();

        const int writers = 8;
        const int each = 2_000;

        await Task.WhenAll(Enumerable.Range(0, writers).Select(writer => Task.Run(() =>
        {
            for (var i = 0; i < each; i++)
                harness.Engine.Post(new ArrivalCommand(Message($"plant/line{writer}/temp", "1")));
        })));

        // Judged or dropped, and nothing in between. The queue is bigger than this run needs, so
        // in practice nothing drops — but the sum is the honest invariant either way.
        await harness.Until(
            () => Judged(harness) + harness.Engine.Dropped == writers * each,
            "every posted message was either judged or counted as dropped");

        var rule = Assert.Single(harness.Engine.Snapshot.Rules);
        Assert.Equal(writers, rule.Topics);
        Assert.Empty(harness.Notifier.Raised);
    }

    private static long Judged(Harness harness)
    {
        var rules = harness.Engine.Snapshot.Rules;

        return rules.Count == 0 ? 0 : rules[0].Evaluated + rules[0].Skipped;
    }

    [Fact]
    public async Task The_snapshot_can_be_read_while_the_pump_is_in_the_middle_of_a_turn()
    {
        await using var harness = Build(Document([Rule("all", "plant/#", Over90)]));
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Run();

        var posting = Task.Run(() =>
        {
            for (var i = 0; i < 5_000; i++)
                harness.Engine.Post(new ArrivalCommand(Message($"plant/line{i % 50}/temp", "94.2")));
        });

        // Two thousand reads from this thread while the pump writes from its own. The published
        // snapshot is an immutable object put in place with one Volatile.Write, so a reader sees
        // the turn before it or the turn after it and never a list being built — which is why
        // GET /api/alerts needs no lock and cannot slow the message path down.
        for (var i = 0; i < 2_000; i++)
        {
            var snapshot = harness.Engine.Snapshot;

            // Walked, not merely fetched: a list still being appended to would throw here, and a
            // walk that disagreed with the count would mean half a turn had been visible.
            Assert.Equal(snapshot.Active.Count, snapshot.Active.Count(alert => alert.Topic.Length > 0));
            Assert.Equal(snapshot.Rules.Count, snapshot.Rules.Count(rule => rule.RuleId.Length > 0));
        }

        await posting;

        await harness.Until(() => harness.Engine.Snapshot.Active.Count == 50, "all fifty pairs rang");
    }
}
