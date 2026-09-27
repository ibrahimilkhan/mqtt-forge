using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;
using MqttForge.Application.Alerts;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;
using MqttForge.UnitTests.Application.Flows;

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

        /// <summary>Waits for the engine to reach a state without moving its clock, for a test that needs the second.</summary>
        public async Task ClockStill(Func<bool> settled, string what)
        {
            var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(10);

            while (DateTime.UtcNow < deadline)
            {
                if (settled()) return;
                await Task.Delay(5);
            }

            Assert.Fail($"Timed out, with the clock held still, waiting until {what}.");
        }

        /// <summary>Points the link at another broker, and answers when the pump saw the move.</summary>
        // Woken by that broker's first reading, of a topic no rule in these tests watches, and not by
        // the clock: so the move is seen at the second it was made, which is what the tests count from.
        public async Task<DateTimeOffset> MoveTo(string host)
        {
            var moves = Moves();

            Connection.At(host, 1883);
            Engine.Post(new ArrivalCommand(new MqttMessage("plant/gate/open", "1", "text", 0, false, Time.GetUtcNow())));

            await ClockStill(() => Moves() > moves, $"the move to {host} to be seen");

            return Time.GetUtcNow();
        }

        private int Moves() => Log.Lines.Count(line => line.Message.StartsWith("The link moved", StringComparison.Ordinal));

        /// <summary>Moves the clock through whole ticks the pump is meant to notice nothing in.</summary>
        public async Task TickAsync(int seconds)
        {
            for (var i = 0; i < seconds; i++)
            {
                Time.Advance(TimeSpan.FromSeconds(1));
                await Task.Delay(10);
            }
        }

        /// <summary>Stops the pump, and fails the test if it has not stopped within ten seconds.</summary>
        // Long enough for a loaded build machine, short enough that a pump that cannot be stopped
        // is a failed test rather than a run that never ends.
        public async Task StopAsync()
        {
            if (_cancellation is null || _pump is null) return;

            await _cancellation.CancelAsync();

            // Awaited rather than abandoned, and that is an assertion: a pump that faulted on any
            // turn of any test in this file fails that test here rather than dying in silence.
            await _pump.WaitAsync(TimeSpan.FromSeconds(10));
        }

        public async ValueTask DisposeAsync()
        {
            await StopAsync();
            _cancellation?.Dispose();
        }
    }

    /// <param name="alarms">
    /// Stands for the notifier and the dispatcher both, when a test is about the order the two are
    /// told in. <see cref="Harness.Notifier"/> then hears nothing.
    /// </param>
    /// <param name="probe">
    /// Stands in front of <see cref="Harness.Subscriber"/>, for a subscriber that does what the
    /// recording one cannot: wait on a broker that never answers, or throw when read.
    /// </param>
    /// <param name="console">The console's hub, for the tests that are about it. None otherwise.</param>
    private static Harness Build(
        AlertRuleDocument? rules = null,
        ConnectionState state = ConnectionState.Connected,
        AlarmCallLog? alarms = null,
        Func<RecordingSubscriber, IMqttSubscriber>? probe = null,
        IAlertConsole? console = null)
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
            ruleStore, stateStore, (IAlertNotifier?)alarms ?? notifier, connection,
            probe?.Invoke(subscriber) ?? subscriber, log, time, alarms, console);

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

        // Both halves, not just the first. The engine subscribes what arrived and then
        // unsubscribes what went — in that order, in one turn of the pump — so a wait that ends
        // at the SUBSCRIBE can return with the UNSUBSCRIBE still to come. It passed on an idle
        // machine and failed under a full parallel run, which is the shape of every race.
        await harness.Until(
            () => harness.Subscriber.Batches.Count == 2 && harness.Subscriber.Unsubscribed.Count == 1,
            "the new filter went up and the old one came down");

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
    public async Task Rule_filters_that_went_between_two_ticks_are_asked_for_again_on_the_next()
    {
        await using var harness = Build(Document([Rule("a", "plant/a/#", Over90)]));
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Run();

        // The link went and came back between two ticks, so no tick saw it down, and the subscriber
        // let the rules' filters go all the same.
        harness.Subscriber.LinkDropped();

        await harness.Until(() => harness.Subscriber.Filters.Count == 1, "the filter to be asked for again");
        Assert.Equal(["plant/a/#"], harness.Subscriber.Batches[1]);
    }

    // MqttnetConnectionManager moves a live link to another broker in one call, and the state is
    // other than Connected only for the handshake: tens of milliseconds against a tick a second.
    [Fact]
    public async Task A_move_to_another_broker_that_no_tick_saw_down_asks_it_again_for_what_the_last_one_refused()
    {
        await using var harness = Build(Document([Rule("a", "plant/a/#", Over90)]));
        harness.Connection.At("broker.a", 1883);
        harness.Subscriber.Refuse = new MessageRejectedException("Not authorised.", ["plant/a/#"]);
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Subscriber.Refuse = null;
        harness.Run();
        await harness.TickAsync(2);

        // The reader points the one link at broker B, which takes the filter A refused.
        harness.Connection.At("broker.b", 1883);
        harness.Subscriber.LinkDropped();

        await harness.Until(() => harness.Subscriber.Filters.Count == 1, "the filter to be asked of the new broker");

        // And the rule is watching again: the refusal was broker A's answer, not the rule's fault.
        harness.Engine.Post(new ArrivalCommand(Message("plant/a/temp", "94.2")));

        await harness.Until(() => harness.Notifier.Raised.Count == 1, "the rule to judge the new broker's reading");
        Assert.False(Assert.Single(harness.Engine.Snapshot.Rules).Faulted);
    }

    [Fact]
    public async Task A_rule_whose_filter_was_refused_judges_again_once_a_new_link_takes_the_filter()
    {
        await using var harness = Build(Document([Rule("a", "plant/a/#", Over90)]));
        harness.Subscriber.Refuse = new MessageRejectedException("Not authorised.", ["plant/a/#"]);
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Run();

        // The broker is restarted with an ACL that allows the filter.
        harness.Connection.State = ConnectionState.Disconnected;
        harness.Subscriber.LinkDropped();
        await harness.TickAsync(2);
        harness.Subscriber.Refuse = null;
        harness.Connection.State = ConnectionState.Connected;

        await harness.Until(() => harness.Subscriber.Filters.Count == 1, "the filter to be asked for on the new link");

        harness.Engine.Post(new ArrivalCommand(Message("plant/a/temp", "94.2")));

        await harness.Until(() => harness.Notifier.Raised.Count == 1, "the rule to judge the reading");
        Assert.False(Assert.Single(harness.Engine.Snapshot.Rules).Faulted);
    }

    // A silence rule judges 'nothing has arrived on this topic for N seconds', and it keeps that
    // per topic. Moving the link to another broker used to carry every topic learned at the first
    // one into the second, where they do not exist — so within N seconds each of them rang, about
    // devices on a broker nobody is watching any more.
    [Fact]
    public async Task Moving_the_link_to_another_broker_forgets_the_topics_the_last_one_taught()
    {
        await using var harness = Build(Document([Rule("dead", "plant/+/temp", new SilenceCondition(30))]));
        harness.Connection.At("broker.a", 1883);
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Run();

        // A couple of ticks at the first broker, which the engine has known it is on since it started.
        await harness.TickAsync(2);

        // A reading at the first broker is what makes a pair to be silent about.
        harness.Engine.Post(new ArrivalCommand(Message("plant/boiler/temp", "21")));
        await harness.Until(() => harness.Engine.Snapshot.Rules[0].Topics == 1, "the topic was learned");

        // The reader points the one link at another broker.
        harness.Connection.At("broker.b", 1883);

        await harness.TickAsync(3);

        Assert.Equal(0, harness.Engine.Snapshot.Rules[0].Topics);

        // ...and nothing rings about a topic that belonged to the broker that was left.
        await harness.TickAsync(60);
        Assert.Empty(harness.Notifier.Raised);
    }

    // A filter that names one topic is another matter: the rule names the device, and learned nothing
    // about it from the broker. It is armed at start, as a save arms it, and a move arms it again, so a
    // boiler that stays silent at the new broker rings there. It used to be forgotten with the rest
    // and not armed again until the next save, and a boiler that never spoke at the new broker never
    // rang. The seconds count from the move, not from the old broker's last reading.
    [Fact]
    public async Task A_topic_a_rule_names_rings_when_it_stays_silent_at_the_broker_the_link_moved_to()
    {
        await using var harness = Build(Document([Rule("dead", "plant/boiler/temp", new SilenceCondition(30))]));
        harness.Connection.At("broker.a", 1883);
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Run();
        await harness.TickAsync(2);

        // The boiler speaks at the first broker, and twenty seconds later the reader moves the link.
        harness.Engine.Post(new ArrivalCommand(Message("plant/boiler/temp", "21")));
        await harness.TickAsync(20);
        var moved = await harness.MoveTo("broker.b");

        // Thirty seconds after the first broker last heard it fall in here, and nothing rings for them.
        await harness.TickAsync(29);
        Assert.Empty(harness.Notifier.Raised);

        // Thirty seconds after the move, with nothing heard at the new broker, it does.
        await harness.TickAsync(1);
        await harness.Until(() => harness.Notifier.Raised.Count == 1, "the boiler's silence at the new broker to ring");

        var alert = Assert.Single(harness.Notifier.Raised);
        Assert.Equal("plant/boiler/temp", alert.Topic);
        Assert.True(alert.FiredAt >= moved.AddSeconds(30));
    }

    [Fact]
    public async Task A_topic_a_rule_names_that_speaks_in_time_at_the_broker_the_link_moved_to_does_not_ring()
    {
        await using var harness = Build(Document([Rule("dead", "plant/boiler/temp", new SilenceCondition(30))]));
        harness.Connection.At("broker.a", 1883);
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Run();
        await harness.TickAsync(2);
        var moved = await harness.MoveTo("broker.b");

        // The boiler speaks at the new broker twenty seconds after the move, inside its thirty.
        await harness.TickAsync(20);
        harness.Engine.Post(new ArrivalCommand(
            new MqttMessage("plant/boiler/temp", "21", "text", 0, false, moved.AddSeconds(20))));

        // Past thirty seconds from the move, and short of thirty from the reading: nothing rings.
        await harness.TickAsync(29);
        Assert.Empty(harness.Notifier.Raised);
    }

    // The move ends the alarms standing at the old broker, as it ends a flow's, and every channel hears
    // each end in its place: after the old broker's last reading, before the new broker's first. The
    // line between them is the new link's ConnectedAt, as the flow engine draws it, so both brokers'
    // readings can wait in the turn that sees the move and each is judged on its own side.
    [Fact]
    public async Task A_move_to_another_broker_ends_the_alarms_standing_there_on_every_channel_and_the_new_ones_readings_raise_afresh()
    {
        var log = new AlarmCallLog();
        await using var harness = Build(Document([Hot(over: 90)]), alarms: log);
        harness.Connection.At("broker.a", 1883);
        await harness.Engine.StartAsync(CancellationToken.None);

        // All of it waits for the pump's first turn, as it would behind a pump held up for the length
        // of the move: two boilers ringing at broker A, a third boiler's reading that A sent before
        // the reader moved the link to broker B, and B's first reading of the first boiler.
        harness.Engine.Post(new ArrivalCommand(Message("plant/k1/temp", "95")));
        harness.Engine.Post(new ArrivalCommand(Message("plant/k2/temp", "96")));
        harness.Engine.Post(new ArrivalCommand(new MqttMessage("plant/k3/temp", "97", "text", 0, false, Start.AddMilliseconds(500))));
        harness.Connection.Link = new BrokerLink("broker.b", 1883, "test", null, false, Start.AddSeconds(1), false, null, null);
        harness.Engine.Post(new ArrivalCommand(new MqttMessage("plant/k1/temp", "95", "text", 0, false, Start.AddSeconds(2))));
        harness.Run();

        await harness.Until(() => log.Alarms.Count == 14, "the alarms, the move and the new broker's alarm to be told and sent");
        Assert.Equal(
            [
                "told raised a", "told raised b", "told raised c",
                "told resolved a", "told resolved b", "told resolved c", "told raised d",
                "sent raised a", "sent raised b", "sent raised c",
                "sent resolved a", "sent resolved b", "sent resolved c", "sent raised d",
            ],
            log.Alarms);

        var snapshot = harness.Engine.Snapshot;
        Assert.Equal(["plant/k1/temp"], snapshot.Active.Select(alert => alert.Topic));
        Assert.Equal(3, snapshot.History.Count);
        Assert.All(snapshot.History, alert => Assert.Equal(AlertEngineCore.ConnectionEnded, alert.ResolvedBy));
    }

    [Fact]
    public async Task A_link_that_stays_on_the_same_broker_keeps_what_it_learned()
    {
        await using var harness = Build(Document([Rule("dead", "plant/boiler/temp", new SilenceCondition(30))]));
        harness.Connection.At("broker.a", 1883);
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Run();
        await harness.TickAsync(2);

        harness.Engine.Post(new ArrivalCommand(Message("plant/boiler/temp", "21")));
        await harness.Until(() => harness.Engine.Snapshot.Rules[0].Topics == 1, "the topic was learned");

        await harness.TickAsync(5);

        Assert.Equal(1, harness.Engine.Snapshot.Rules[0].Topics);
    }

    // Asked for on 2026-09-06, overruling the earlier behaviour this test used to pin: a broker
    // that refused a filter refuses it again, so asking once a second for the life of the link is
    // a wasted round trip a second — and some brokers count that as abuse.
    [Fact]
    public async Task A_filter_the_broker_refuses_is_not_asked_for_again_on_this_link()
    {
        await using var harness = Build(Document([Rule("a", "plant/a/#", Over90)]));
        harness.Subscriber.Refuse = new MessageRejectedException("The broker refused 'plant/a/#'.");

        // A refusal is the broker's answer, not a fault in the engine: StartAsync comes back.
        await harness.Engine.StartAsync(CancellationToken.None);

        Assert.Single(harness.Subscriber.Batches);
        Assert.Contains(harness.Log.Lines, line => line.Level == LogLevel.Warning);

        // Let the broker change its mind. Nothing asks it, because nothing on this link has
        // changed: not the rule set, and not the connection.
        harness.Run();
        harness.Subscriber.Refuse = null;

        await Task.Delay(80);
        Assert.Single(harness.Subscriber.Batches);
        Assert.Empty(harness.Subscriber.Filters);
    }

    // The rule the broker would not carry is a rule that is watching nothing, and the panel draws
    // a faulted rule with its reason — so the reader is told rather than left with a rule whose
    // every count stands still.
    [Fact]
    public async Task A_rule_whose_filter_was_refused_is_shown_as_faulted()
    {
        await using var harness = Build(Document([Rule("a", "plant/a/#", Over90)]));
        harness.Subscriber.Refuse = new MessageRejectedException("The broker refused 'plant/a/#'.");

        await harness.Engine.StartAsync(CancellationToken.None);

        var rule = Assert.Single(harness.Engine.Snapshot.Rules);
        Assert.True(rule.Faulted);
        Assert.Contains("plant/a/#", rule.FaultReason);
    }

    // ...and a rule set the reader has edited is a new question, so the filter is offered again.
    [Fact]
    public async Task A_refused_filter_is_asked_for_again_once_the_rules_are_edited()
    {
        await using var harness = Build(Document([Rule("a", "plant/a/#", Over90)]));
        harness.Subscriber.Refuse = new MessageRejectedException("The broker refused 'plant/a/#'.");
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Run();

        harness.Subscriber.Refuse = null;
        harness.Engine.Post(new RuleSetChangedCommand([Rule("a", "plant/a/#", Over90)]));

        await harness.Until(() => harness.Subscriber.Filters.Count == 1, "the filter went up after the edit");
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

        await harness.Until(() => harness.Notifier.Resolved.Count == 1 && harness.Subscriber.Unsubscribed.Count == 1,
            "the save to end it and take its filter down");

        // SetRules is the only place this resolution can come from — no message will ever reach
        // that pair again — and the pump has to carry the body out.
        Assert.Equal("rule removed", Assert.Single(harness.Notifier.Resolved).ResolvedBy);
        Assert.Single(harness.Engine.Snapshot.History);
        Assert.Empty(harness.Engine.Snapshot.Active);
        Assert.Equal(["plant/+/temp"], harness.Subscriber.Unsubscribed);

        harness.Engine.Post(new ClearHistoryCommand());

        await harness.Until(() => harness.Engine.Snapshot.History.Count == 0, "the history was cleared");
    }

    // A channel outside the process knows an alert by its rule and its topic alone: the broker's
    // channel publishes to a topic named by the two, and a webhook's body carries no alert id. So
    // an alarm that ends and the next one on the same pair are one alarm out there, and the order
    // they are told in is the only thing that says which of them stands.
    [Fact]
    public async Task An_alarm_an_edit_ends_and_the_next_reading_raises_again_in_one_turn_are_told_and_sent_in_that_order()
    {
        var log = new AlarmCallLog();
        await using var harness = Build(Document([Hot(over: 90)]), alarms: log);
        await harness.Engine.StartAsync(CancellationToken.None);

        // The boiler rings; the reader lowers the threshold while it stands, which ends it, as any
        // change to what a ringing rule judges does; and the next reading rings it again under the
        // edited rule. All three wait for the same turn.
        harness.Engine.Post(new ArrivalCommand(Message("plant/boiler/temp", "95")));
        harness.Engine.Post(new RuleSetChangedCommand([Hot(over: 85)]));
        harness.Engine.Post(new ArrivalCommand(Message("plant/boiler/temp", "95")));
        harness.Run();

        await harness.Until(() => log.Alarms.Count == 6, "every end of both alarms to be told and sent");
        Assert.Equal(
            ["told raised a", "told resolved a", "told raised b", "sent raised a", "sent resolved a", "sent raised b"],
            log.Alarms);
    }

    // ---- faults that are not shutdown ----

    // What MQTTnet 5 can hand back for a SUBSCRIBE that was waiting when its keep-alive gave up on
    // the link: the cancellation of the client's own receive loop, which is the link going and not
    // this engine stopping.
    private static OperationCanceledException LinkCalledOff() =>
        new("The link went while the SUBSCRIBE was out.");

    [Fact]
    public async Task A_subscribe_the_link_called_off_is_asked_for_again_and_the_rules_are_judged_meanwhile()
    {
        await using var harness = Build(Document([Rule("a", "plant/a/#", Over90)]));
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Run();

        harness.Subscriber.Refuse = LinkCalledOff();
        harness.Engine.Post(new RuleSetChangedCommand([Rule("a", "plant/a/#", Over90), Rule("b", "plant/b/#", Over90)]));
        await harness.Until(() => harness.Subscriber.Batches.Count >= 2, "the SUBSCRIBE the link called off");

        harness.Engine.Post(new ArrivalCommand(Message("plant/a/temp", "94.2")));
        await harness.Until(() => harness.Notifier.Raised.Count == 1, "the next arrival to be judged");

        harness.Subscriber.Refuse = null;

        await harness.Until(() => harness.Subscriber.Filters.Any(filter => filter.Filter == "plant/b/#"),
            "the filter to be asked for again");
        Assert.False(harness.Engine.Snapshot.Rules.Single(rule => rule.RuleId == "b").Faulted);
    }

    [Fact]
    public async Task A_subscribe_the_link_called_off_at_start_does_not_keep_the_engine_from_starting()
    {
        await using var harness = Build(Document([Rule("a", "plant/a/#", Over90)]));
        harness.Subscriber.Refuse = LinkCalledOff();

        await harness.Engine.StartAsync(CancellationToken.None);

        harness.Subscriber.Refuse = null;
        harness.Run();

        await harness.Until(() => harness.Subscriber.Filters.Count == 1, "the filter to be asked for again");
    }

    // What the subscriber says of a SUBSCRIBE the broker never answered, and of one the link went
    // under. Neither is a refusal: the rule is not set aside, and the filter is asked for again.
    [Theory]
    [InlineData("no answer")]
    [InlineData("link went")]
    public async Task A_subscribe_that_went_unanswered_or_lost_its_link_faults_no_rule_and_is_asked_for_again(string how)
    {
        await using var harness = Build(Document([Rule("a", "plant/a/#", Over90)]));
        harness.Subscriber.Refuse = how == "no answer"
            ? new BrokerDidNotAnswerException("The broker did not answer the SUBSCRIBE for 'plant/a/#' within 10 seconds.")
            : new NotConnectedException("The link to the broker went while the SUBSCRIBE for 'plant/a/#' was waiting for an answer.");

        await harness.Engine.StartAsync(CancellationToken.None);
        Assert.False(Assert.Single(harness.Engine.Snapshot.Rules).Faulted);

        harness.Subscriber.Refuse = null;
        harness.Run();

        await harness.Until(() => harness.Subscriber.Filters.Count == 1, "the filter to be asked for again");
    }

    // Each attempt at a broker that keeps the link and does not answer holds the pump for the
    // subscriber's whole deadline. Asked again on the very next turn, it left the pump one turn per
    // deadline for as long as the broker kept the link up; now it is asked again after a pause.
    [Fact]
    public async Task A_subscribe_the_broker_did_not_answer_is_asked_again_after_a_pause_and_not_on_the_next_turn()
    {
        await using var harness = Build(Document([Rule("a", "plant/a/#", Over90)]));
        harness.Subscriber.Refuse = new BrokerDidNotAnswerException(
            "The broker did not answer the SUBSCRIBE for 'plant/a/#' within 10 seconds.");
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Subscriber.Refuse = null;
        harness.Run();

        await harness.TickAsync((int)AlertEngine.NoAnswerPause.TotalSeconds - 1);
        Assert.Single(harness.Subscriber.Batches);

        await harness.TickAsync(1);
        await harness.Until(() => harness.Subscriber.Filters.Count == 1, "the filter to be asked for again once the pause is over");
        Assert.Equal(2, harness.Subscriber.Batches.Count);
    }

    // A pause is about the broker that did not answer. A new link is a new answer, asked for at once.
    [Fact]
    public async Task A_new_link_asks_for_the_filters_at_once_whatever_pause_the_last_one_left()
    {
        await using var harness = Build(Document([Rule("a", "plant/a/#", Over90)]));
        harness.Subscriber.Refuse = new BrokerDidNotAnswerException(
            "The broker did not answer the SUBSCRIBE for 'plant/a/#' within 10 seconds.");
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Subscriber.Refuse = null;
        harness.Run();

        harness.Connection.State = ConnectionState.Disconnected;
        harness.Subscriber.LinkDropped();
        await harness.TickAsync(2);
        harness.Connection.State = ConnectionState.Connected;
        await harness.TickAsync(1);

        // With the clock held three seconds in, inside the pause the first link left.
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(10);
        while (harness.Subscriber.Filters.Count == 0 && DateTime.UtcNow < deadline) await Task.Delay(5);
        Assert.Single(harness.Subscriber.Filters);
    }

    // A broker that goes on keeping the link and leaving the SUBSCRIBE unanswered is asked less and
    // less often: five seconds after the first attempt it left, ten after the second, and so on up to
    // a minute (NoAnswerBackoff). Each attempt holds the pump for the subscriber's whole deadline, so
    // five seconds apart such a broker had the pump ten seconds in every fifteen for as long as it
    // kept the link.
    [Fact]
    public async Task A_broker_that_goes_on_not_answering_is_asked_again_after_a_longer_pause_each_time()
    {
        await using var harness = Build(Document([Rule("a", "plant/a/#", Over90)]));
        harness.Subscriber.Clock = harness.Time;
        harness.Subscriber.Refuse = new BrokerDidNotAnswerException(
            "The broker did not answer the SUBSCRIBE for 'plant/a/#' within 10 seconds.");
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Run();

        await harness.TickAsync((int)AlertEngine.NoAnswerPause.TotalSeconds);
        await harness.Until(() => harness.Subscriber.Batches.Count == 2, "the filter to be asked for again after the first pause");
        var again = harness.Subscriber.AskedAt[1];

        // Not answered again, so the next is ten seconds off, not five.
        await harness.TickAsync((int)(again.AddSeconds(9) - harness.Time.GetUtcNow()).TotalSeconds);
        Assert.Equal(2, harness.Subscriber.Batches.Count);

        await harness.TickAsync(1);
        await harness.Until(() => harness.Subscriber.Batches.Count == 3, "the filter to be asked for again after the second pause");
        Assert.True(harness.Subscriber.AskedAt[2] - again >= TimeSpan.FromSeconds(10));
    }

    // Yes or no, an answer ends the run: the next silence is the first of a new one, and paused for
    // five seconds, not for the twenty the run before it had come to.
    [Fact]
    public async Task An_answer_makes_the_next_pause_the_first_again()
    {
        var silence = new BrokerDidNotAnswerException("The broker did not answer the SUBSCRIBE within 10 seconds.");
        await using var harness = Build(Document([Rule("a", "plant/a/#", Over90)]));
        harness.Subscriber.Clock = harness.Time;
        harness.Subscriber.Refuse = silence;
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Run();

        await harness.TickAsync((int)AlertEngine.NoAnswerPause.TotalSeconds);
        await harness.Until(() => harness.Subscriber.Batches.Count == 2, "the filter to be asked for again after the first pause");
        harness.Subscriber.Refuse = null;
        await harness.Until(() => harness.Subscriber.Filters.Count == 1, "the filter to be taken after the second pause");

        // A rule saved with a filter of its own, and the broker silent again.
        harness.Subscriber.Refuse = silence;
        harness.Engine.Post(new RuleSetChangedCommand([Rule("a", "plant/a/#", Over90), Rule("b", "plant/b/#", Over90)]));
        await harness.Until(() => harness.Subscriber.Batches.Count == 4, "the new filter to be asked for");
        var unanswered = harness.Subscriber.AskedAt[3];

        harness.Subscriber.Refuse = null;
        await harness.Until(() => harness.Subscriber.Filters.Count == 2, "the new filter to be asked for again after a pause");
        Assert.InRange(harness.Subscriber.AskedAt[4] - unanswered, AlertEngine.NoAnswerPause, TimeSpan.FromSeconds(9));
    }

    // A link that went and came back between two ticks is a new link as well, though no tick saw it
    // down: MqttnetConnectionManager dials again in one call. Its ConnectedAt says it is not the link
    // the broker left unanswered, and the filters are asked for on it at once.
    [Fact]
    public async Task A_link_that_came_back_between_two_ticks_asks_for_the_filters_at_once_whatever_pause_the_last_one_left()
    {
        await using var harness = Build(Document([Rule("a", "plant/a/#", Over90)]));
        harness.Connection.Link = new BrokerLink("broker.a", 1883, "test", null, false, Start.AddMinutes(-1), false, null, null);
        harness.Subscriber.Refuse = new BrokerDidNotAnswerException(
            "The broker did not answer the SUBSCRIBE for 'plant/a/#' within 10 seconds.");
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Subscriber.Refuse = null;
        harness.Run();

        // Dropped and dialled again, to the same broker, and the new link's first reading to wake the
        // pump: with the clock held still at the start, inside the pause the first link left.
        harness.Subscriber.LinkDropped();
        harness.Connection.Link = new BrokerLink("broker.a", 1883, "test", null, false, Start, false, null, null);
        harness.Engine.Post(new ArrivalCommand(Message("plant/a/temp", "20")));

        await harness.ClockStill(() => harness.Subscriber.Filters.Count == 1, "the filter to be asked for on the new link");
    }

    // A rule the reader has just saved is a person waiting to see it at work, and the pause a broker
    // that did not answer leaves is up to a minute: the filters are asked for at once, whatever it is.
    [Fact]
    public async Task A_rule_saved_during_a_pause_has_the_filters_asked_for_at_once()
    {
        await using var harness = Build(Document([Rule("a", "plant/a/#", Over90)]));
        harness.Subscriber.Refuse = new BrokerDidNotAnswerException(
            "The broker did not answer the SUBSCRIBE for 'plant/a/#' within 10 seconds.");
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Subscriber.Refuse = null;
        harness.Run();

        // Saved with the clock held still at the start, inside the pause the unanswered SUBSCRIBE left.
        harness.Engine.Post(new RuleSetChangedCommand([Rule("a", "plant/a/#", Over90), Rule("b", "plant/b/#", Over90)]));

        await harness.ClockStill(() => harness.Subscriber.Filters.Count == 2, "the saved rules' filters to be asked for");
    }

    // A save is no answer, though. One the broker leaves unanswered as well is one more attempt in the
    // run, and the pause after it is the run's next: ten seconds after the second, not five again.
    [Fact]
    public async Task A_save_the_broker_leaves_unanswered_too_is_followed_by_the_next_pause_of_the_run()
    {
        await using var harness = Build(Document([Rule("a", "plant/a/#", Over90)]));
        harness.Subscriber.Clock = harness.Time;
        harness.Subscriber.Refuse = new BrokerDidNotAnswerException(
            "The broker did not answer the SUBSCRIBE for 'plant/a/#' within 10 seconds.");
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Run();

        harness.Engine.Post(new RuleSetChangedCommand([Rule("a", "plant/a/#", Over90), Rule("b", "plant/b/#", Over90)]));
        await harness.ClockStill(() => harness.Subscriber.Batches.Count == 2, "the saved rules' filters to be asked for");
        harness.Subscriber.Refuse = null;

        var second = NoAnswerBackoff.After(2);
        await harness.TickAsync((int)second.TotalSeconds - 1);
        Assert.Equal(2, harness.Subscriber.Batches.Count);

        await harness.TickAsync(1);
        await harness.Until(() => harness.Subscriber.Filters.Count == 2, "the filters to be asked for again after the run's second pause");
        Assert.True(harness.Subscriber.AskedAt[2] - harness.Subscriber.AskedAt[1] >= second);
    }

    [Fact]
    public async Task A_cancelled_alarm_channel_is_contained_in_that_channel()
    {
        var cancelled = new OperationCanceledException("The channel gave up.");
        var log = new AlarmCallLog { NotifierFault = cancelled, DispatcherFault = cancelled };
        await using var harness = Build(Document([Hot(over: 90)]), alarms: log);
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Run();

        harness.Engine.Post(new ArrivalCommand(Message("plant/boiler/temp", "95")));

        // Neither channel is handed the engine's token, so neither can be telling it to stop: the
        // broker's channel is still tried after the console's gave up, each failure is said as that
        // channel's own, and the pump is there for the next reading.
        await harness.Until(() => harness.Log.Lines.Any(line => line.Message.StartsWith("An alert dispatcher threw")),
            "the dispatcher's own failure to be logged");
        Assert.Equal(["told raised", "sent raised"], log.Calls);

        harness.Engine.Post(new ArrivalCommand(Message("plant/kiln/temp", "95")));

        await harness.Until(() => log.Calls.Count == 4, "the next reading to be judged and told");
        Assert.DoesNotContain(harness.Log.Lines, line => line.Message.StartsWith("A turn of the alert engine failed"));
    }

    [Fact]
    public async Task A_subscribe_the_broker_does_not_answer_does_not_hold_back_what_its_turn_decided()
    {
        SubscriberProbe? probe = null;
        await using var harness = Build(Document([Rule("a", "plant/a/#", Over90)]),
            probe: inner => probe = new SubscriberProbe(inner));
        await harness.Engine.StartAsync(CancellationToken.None);

        // One turn: a reading that rings, and a rule set whose new filter goes to a broker that
        // never answers the SUBSCRIBE.
        probe!.Stall = true;
        harness.Engine.Post(new ArrivalCommand(Message("plant/a/temp", "94.2")));
        harness.Engine.Post(new RuleSetChangedCommand([Rule("a", "plant/a/#", Over90), Rule("b", "plant/b/#", Over90)]));
        harness.Run();

        await harness.Until(() => probe.Held == 1, "the SUBSCRIBE to be waiting on the broker");
        await harness.Until(() => harness.Notifier.Raised.Count == 1 && harness.State.Saves.Count == 1,
            "the turn's alarm to be told and written down while it waits");
        Assert.Single(harness.Engine.Snapshot.Active);
    }

    // The turn's own catch, and nothing in front of it: a tick's look at the filters reads the
    // subscriber outside every channel's catch and the SUBSCRIBE's. A cancellation out of there that
    // is not the engine's is a failed turn like any other fault, and the pump carries on judging.
    // Read as shutdown, it ended the pump for good, with nothing in the log to say so.
    [Fact]
    public async Task A_cancellation_out_of_a_look_at_the_filters_is_a_failed_turn_and_the_rules_are_judged_after_it()
    {
        SubscriberProbe? probe = null;
        await using var harness = Build(Document([Rule("a", "plant/a/#", Over90)]),
            probe: inner => probe = new SubscriberProbe(inner));
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Run();

        probe!.FiltersFault = new OperationCanceledException("A read of the filters was called off.");
        await harness.Until(
            () => harness.Log.Lines.Any(line => line.Message.StartsWith("A turn of the alert engine failed", StringComparison.Ordinal)),
            "the tick's look at the filters to fail its turn");
        probe.FiltersFault = null;

        harness.Engine.Post(new ArrivalCommand(Message("plant/a/temp", "94.2")));

        await harness.Until(() => harness.Notifier.Raised.Count == 1, "the next reading to be judged");
    }

    // ---- a console that is slow to read ----

    // SignalR writes one message at a time to a connection, so a frame to a console that has
    // stopped reading waits for as long as that connection lasts — up to its client timeout — and
    // a pump that waited on it held every rule in the product with it.
    [Fact]
    public async Task A_console_that_stops_reading_holds_up_no_rule()
    {
        var console = new RecordingAlertConsole();
        await using var harness = Build(Document([Rule("boiler", "plant/+/temp", Over90)]), console: console);
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Run();
        console.Stall = true;

        harness.Engine.Post(new ArrivalCommand(Message("plant/boiler/temp", "94.2")));
        await harness.Until(() => console.Held == 1, "the alarm's frame to be stuck with the console");

        harness.Engine.Post(new ArrivalCommand(Message("plant/kiln/temp", "99")));

        await harness.Until(() => harness.Notifier.Raised.Count == 2 && harness.Engine.Snapshot.Active.Count == 2,
            "the next reading to be judged and written to the log, with the frame still stuck");
        Assert.Equal(1, console.Held);
    }

    [Fact]
    public async Task Alarms_stuck_with_a_console_go_out_in_their_order_once_it_is_let_go()
    {
        var console = new RecordingAlertConsole();
        await using var harness = Build(Document([Rule("boiler", "plant/+/temp", Over90)]), console: console);
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Run();
        console.Stall = true;

        // The boiler rings and its frame sticks; the kiln rings; the boiler cools, and the tick after
        // it ends the boiler's alarm.
        harness.Engine.Post(new ArrivalCommand(Message("plant/boiler/temp", "94.2")));
        await harness.Until(() => console.Held == 1, "the first alarm's frame to be stuck with the console");
        harness.Engine.Post(new ArrivalCommand(Message("plant/kiln/temp", "99")));
        harness.Engine.Post(new ArrivalCommand(Message("plant/boiler/temp", "20")));

        await harness.Until(() => harness.Notifier.Raised.Count == 2 && harness.Notifier.Resolved.Count == 1,
            "both alarms to be raised and the first to end, with its frame still stuck");

        console.Stall = false;

        await harness.Until(() => console.Told.Count == 3, "every alarm to reach the console");
        Assert.Equal(["raised a", "raised b", "resolved a"], console.Told);
    }

    [Fact]
    public async Task An_alarm_stuck_with_a_console_is_called_off_when_the_engine_stops()
    {
        var console = new RecordingAlertConsole();
        await using var harness = Build(Document([Rule("boiler", "plant/+/temp", Over90)]), console: console);
        await harness.Engine.StartAsync(CancellationToken.None);
        harness.Run();
        console.Stall = true;

        harness.Engine.Post(new ArrivalCommand(Message("plant/boiler/temp", "94.2")));
        await harness.Until(() => console.Held == 1, "the alarm's frame to be stuck with the console");

        await harness.StopAsync();

        Assert.Equal(0, console.Held);
    }

    // The drop total is a frame like any other, and a console stuck on it is a console stuck.
    [Fact]
    public async Task A_console_stuck_on_the_drop_total_holds_up_no_rule_and_is_told_the_newest()
    {
        var console = new RecordingAlertConsole();
        await using var harness = Build(Document([Rule("boiler", "plant/+/temp", Over90)]), console: console);
        await harness.Engine.StartAsync(CancellationToken.None);

        // More than the queue holds, with nothing draining it: the first turn has a total to tell.
        const int posted = AlertEngine.QueueCapacity + 10;
        for (var i = 0; i < posted; i++)
            harness.Engine.Post(new ArrivalCommand(Message($"noise/{i}", "1")));

        console.Stall = true;
        harness.Run();
        await harness.Until(() => console.Held == 1, "the drop total to be stuck with the console");

        harness.Engine.Post(new ArrivalCommand(Message("plant/boiler/temp", "94.2")));
        await harness.Until(() => harness.Notifier.Raised.Count == 1, "the next reading to be judged, with the total still stuck");

        console.Stall = false;

        await harness.Until(() => console.Dropped.Count >= 1 && console.Told.Count == 1,
            "the total and the alarm to reach the console");
        Assert.Equal(harness.Engine.Dropped, console.Dropped[^1]);
    }

    /// <summary>A rule that rings over <paramref name="over"/> and asks for its alarm on the broker.</summary>
    private static AlertRule Hot(double over) =>
        new("hot", "Boiler temperature", Enabled: true, "plant/+/temp", Field: null,
            new ThresholdCondition(ThresholdOp.Gt, over), Clear: null, For: null, Cooldown: null,
            AlertSeverity.Critical, [new ScreenAction(), new PublishAction(null, 1, true)]);

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
