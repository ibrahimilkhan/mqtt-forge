using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using MqttForge.Application.Alerts;
using MqttForge.Application.Flows;
using MqttForge.Application.Services;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;
using MqttForge.UnitTests.Application.Alerts;
using MqttForge.UnitTests.Application.Flows;
using NSubstitute;

namespace MqttForge.UnitTests.Application;

// The service against a real engine on a fake clock. A deploy is answered once the engine is running
// it, so the pump has to turn for a save to come back — and a test that holds it still, by not
// starting it, can see what the answer waits for.
public sealed class FlowServiceTests : IAsyncLifetime
{
    private static readonly DateTimeOffset T0 = new(2026, 9, 26, 9, 0, 0, TimeSpan.Zero);

    private readonly FakeTimeProvider _time = new(T0);
    private readonly FakeFlowStore _store = new();
    private readonly ILinkForRules _link = Substitute.For<ILinkForRules>();
    private readonly IAlertNotifier _alarms = Substitute.For<IAlertNotifier>();
    private readonly CancellationTokenSource _stop = new();
    private readonly FlowEngine _engine;
    private readonly FlowService _sut;
    private Task? _pump;

    public FlowServiceTests()
    {
        _engine = new FlowEngine(new FlowRuntime(), _store, _alarms,
            Substitute.For<IFlowNotifier>(), new FakeConnection(), new RecordingSubscriber(), new RecordingPublisher(),
            new AlertEngineOptions(), NullLogger<FlowEngine>.Instance, _time);
        _sut = new FlowService(_store, _engine, _link, new AlertEngineOptions());
    }

    public Task InitializeAsync() => _engine.StartAsync(CancellationToken.None);

    public async Task DisposeAsync()
    {
        await _stop.CancelAsync();
        if (_pump is not null) await _pump.WaitAsync(TimeSpan.FromSeconds(10));
        _stop.Dispose();
    }

    private void Run() => _pump = Task.Run(() => _engine.RunAsync(_stop.Token));

    private static async Task Until(Func<bool> settled, string what)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(10);

        while (DateTime.UtcNow < deadline)
        {
            if (settled()) return;
            await Task.Delay(5);
        }

        Assert.Fail($"Timed out waiting until {what}.");
    }

    private static Flow Good(string id = "f1", bool enabled = true)
    {
        var flow = new ChartBuilder(id).Node("start", "start").Node("n1", "debug").Node("end", "end").Then("start", "n1", "end").Build();
        return flow with { Enabled = enabled };
    }

    /// <summary>A flow with one thing wrong with it, said on its node: a Publish with no topic.</summary>
    private static Flow Broken(string id = "f1") =>
        new ChartBuilder(id).Node("start", "start").Node("n1", "publish").Node("end", "end").Then("start", "n1", "end").Build();

    /// <summary>A flow that waits on an MQTT in, so it stays running and whether the engine runs it is one question away.</summary>
    private static Flow Listening(string id = "f1", string filter = "plant/k1/button") => new ChartBuilder(id)
        .Node("start", "start").Node("in", "mqttIn", new { filter }).Node("end", "end")
        .Then("start", "in", "end")
        .Build();

    /// <summary>A flow that raises an alarm the moment it is switched on, so the turn that runs it waits on the alarm log.</summary>
    private static Flow Ringing(string id = "f1") => new ChartBuilder(id)
        .Node("start", "start").Node("ring", "alarmRaise", new { name = "Pressed", level = "warn" }).Node("end", "end")
        .Then("start", "ring").Wire("ring", "raised", "end").Wire("ring", "up", "end")
        .Build();

    [Fact]
    public async Task A_flow_that_compiles_is_kept_and_asks_for_a_link_when_it_is_on()
    {
        Run();

        var result = await _sut.SaveAsync(Good(), CancellationToken.None);

        Assert.NotNull(result.Flow);
        Assert.Single(_store.Flows);
        await _link.Received(1).WantedAsync(Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task A_flow_that_is_off_is_kept_without_asking_for_a_link()
    {
        Run();

        await _sut.SaveAsync(Good(enabled: false), CancellationToken.None);

        Assert.Single(_store.Flows);
        await _link.DidNotReceive().WantedAsync(Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task A_flow_that_does_not_compile_is_refused_and_not_kept()
    {
        var result = await _sut.SaveAsync(Broken(), CancellationToken.None);

        Assert.Null(result.Flow);
        Assert.Equal("node:n1", Assert.Single(result.Problems).Key);
        Assert.Empty(_store.Flows);
    }

    [Fact]
    public async Task A_fifty_first_flow_is_refused_and_a_known_one_can_still_be_saved()
    {
        Run();
        _store.Flows = [.. Enumerable.Range(0, FlowLimits.Flows).Select(i => Good($"f{i}"))];

        Assert.Null((await _sut.SaveAsync(Good("one-too-many"), CancellationToken.None)).Flow);
        Assert.NotNull((await _sut.SaveAsync(Good("f3"), CancellationToken.None)).Flow);
    }

    [Fact]
    public async Task Saving_over_an_unreadable_file_is_refused_with_the_exception_the_api_maps()
    {
        _store.Unreadable = true;

        await Assert.ThrowsAsync<FlowsUnreadableException>(() => _sut.SaveAsync(Good(), CancellationToken.None));
    }

    [Fact]
    public async Task The_view_reports_a_hand_edited_flow_that_does_not_compile()
    {
        _store.Flows = [Good(), Broken("bad")];

        var view = await _sut.GetAsync(CancellationToken.None);

        Assert.Equal(2, view.Flows.Count);
        Assert.Equal("bad", Assert.Single(view.Problems).FlowId);
        Assert.Equal("mqttforge/alerts/", view.AlertTopicPrefix);
    }

    [Fact]
    public async Task Deleting_says_whether_there_was_a_flow_to_delete()
    {
        Run();
        _store.Flows = [Good()];

        Assert.True(await _sut.DeleteAsync("f1", CancellationToken.None));
        Assert.False(await _sut.DeleteAsync("f1", CancellationToken.None));
    }

    // ---- what a deploy's answer means ----

    // Activate is answered once the engine is running what was saved, so whatever the page asks of the
    // engine next meets the flow as it was saved, and not the one before it.
    [Fact]
    public async Task A_deploy_is_answered_once_the_engine_is_running_it()
    {
        var saving = _sut.SaveAsync(Listening(), CancellationToken.None);

        Assert.False(saving.IsCompleted);

        Run();
        await saving.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.True(_engine.IsActive("f1"));
    }

    [Fact]
    public async Task A_delete_is_answered_once_the_engine_has_stopped_the_flow()
    {
        Run();

        // The pump held up by a turn telling an alarm to a log slow to take it: it reaches nothing posted
        // after that until the log lets it go. The flow raises the alarm the moment it is switched on.
        var told = new TaskCompletionSource();
        _alarms.RaisedAsync(Arg.Any<IReadOnlyList<Alert>>()).Returns(told.Task);
        await _sut.SaveAsync(Ringing(), CancellationToken.None);
        await Until(() => _alarms.ReceivedCalls().Any(), "the pump to be held up telling the alarm");

        // A delete answered before the engine has stopped the flow would leave a deleted flow running,
        // and the page that deleted it showing it gone.
        var deleting = _sut.DeleteAsync("f1", CancellationToken.None);
        Assert.False(deleting.IsCompleted);
        Assert.True(_engine.IsActive("f1"));

        told.SetResult();

        Assert.True(await deleting.WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.False(_engine.IsActive("f1"));
    }

    // Bounded: a pump held up — by an alarm channel slow to answer, or a broker slow with a
    // SUBSCRIBE — must not leave the console's Deploy waiting on it. The flow is kept all the same,
    // and runs as soon as the pump is free.
    [Fact]
    public async Task A_deploy_the_engine_is_too_busy_to_take_is_answered_after_a_bounded_wait()
    {
        var saving = _sut.SaveAsync(Listening(), CancellationToken.None);
        Assert.False(saving.IsCompleted);

        _time.Advance(FlowEngine.DeployPatience);
        var result = await saving.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.NotNull(result.Flow);
        Assert.False(_engine.IsActive("f1"));

        Run();
        await Until(() => _engine.IsActive("f1"), "the flow to run once the pump is free");
    }

    // ---- a client that goes away ----

    // Between the write and the deploy. Gone there, it would leave its flow on disk and not running,
    // until the next deploy of anything or the next restart — and the page had been told nothing.
    [Fact]
    public async Task A_client_that_goes_away_once_its_flow_is_written_still_has_it_run()
    {
        Run();
        using var client = new CancellationTokenSource();
        _store.AfterWrite = client.Cancel;

        try
        {
            await _sut.SaveAsync(Listening(), client.Token);
        }
        catch (OperationCanceledException)
        {
            // Whatever the answer is, nobody is waiting for it.
        }

        await Until(() => _engine.IsActive("f1"), "the written flow to run");
    }

    // While the answer waits for the engine. The flow is written and runs all the same, and a flow that
    // runs needs the link: a host that dials for its flows has to be asked, whoever stayed to hear.
    [Fact]
    public async Task A_client_that_goes_away_while_its_deploy_waits_still_has_the_link_asked_for()
    {
        using var client = new CancellationTokenSource();
        var saving = _sut.SaveAsync(Listening(), client.Token);
        Assert.False(saving.IsCompleted);

        await client.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => saving);

        await _link.Received(1).WantedAsync(Arg.Is<CancellationToken>(ct => !ct.IsCancellationRequested));
    }

    [Fact]
    public async Task A_client_that_goes_away_once_its_flow_is_deleted_still_has_it_stopped()
    {
        Run();
        await _sut.SaveAsync(Listening(), CancellationToken.None);
        using var client = new CancellationTokenSource();
        _store.AfterWrite = client.Cancel;

        try
        {
            await _sut.DeleteAsync("f1", client.Token);
        }
        catch (OperationCanceledException)
        {
            // As above.
        }

        await Until(() => !_engine.IsActive("f1"), "the deleted flow to stop");
    }

    // ---- a test of the drawing ----

    [Fact]
    public async Task A_test_is_run_and_not_kept()
    {
        Run();

        var result = await _sut.TestAsync(Listening(), CancellationToken.None);

        Assert.NotNull(result.Flow);
        await Until(() => _engine.IsTesting("f1"), "the test to be running");
        Assert.Empty(_store.Flows);
    }

    [Fact]
    public async Task A_test_that_does_not_compile_is_refused_with_its_problems()
    {
        var result = await _sut.TestAsync(new ChartBuilder().Node("start", "start").Build(), CancellationToken.None);

        Assert.Null(result.Flow);
        Assert.Contains(result.Problems, problem => problem.Key == "node:start");
    }

    [Fact]
    public async Task Stopping_says_whether_there_was_a_test_to_stop()
    {
        Run();
        Assert.False(_sut.StopTest("f1"));

        await _sut.TestAsync(Listening(), CancellationToken.None);
        await Until(() => _engine.IsTesting("f1"), "the test to be running");

        Assert.True(_sut.StopTest("f1"));
        await Until(() => !_engine.IsTesting("f1"), "the test to stop");
    }

    [Fact]
    public async Task Deleting_a_flow_stops_its_test()
    {
        Run();
        await _sut.SaveAsync(Listening(), CancellationToken.None);
        await _sut.TestAsync(Listening(), CancellationToken.None);
        await Until(() => _engine.IsTesting("f1"), "the test to be running");

        await _sut.DeleteAsync("f1", CancellationToken.None);

        await Until(() => !_engine.IsTesting("f1"), "the deleted flow's test to stop");
    }

    [Fact]
    public async Task A_test_asks_for_the_link()
    {
        await _sut.TestAsync(Listening(), CancellationToken.None);

        await _link.Received(1).WantedAsync(Arg.Any<CancellationToken>());
    }

    // ---- a test, and the dial it asks for ----

    /// <summary>Makes the first ask for the link a dial that goes on until the returned source is set, and every ask after it answer at once.</summary>
    // A host that dials at start-up, with the link down, dials for up to its connect timeout, which is longer
    // than the console waits for an answer. A link that is being dialled is asked for again and answers at
    // once, as BrokerLinkSupervisor.WantedAsync does, so only the first is held.
    private TaskCompletionSource HoldTheFirstDial()
    {
        var dial = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var asked = 0;

        _link.WantedAsync(Arg.Any<CancellationToken>()).Returns(_ => asked++ == 0 ? dial.Task : Task.CompletedTask);

        return dial;
    }

    // The test is handed over before the link is asked for, as a save's deploy is, so the pump starts it
    // while the dial is still going. Asked for first, it waited for the dial to be over, and everything
    // pressed in the meantime was handed over before it: see the three tests below.
    [Fact]
    public async Task A_test_is_handed_over_before_the_link_is_asked_for_and_does_not_wait_for_the_dial()
    {
        Run();
        var dial = HoldTheFirstDial();

        var testing = _sut.TestAsync(Listening(), CancellationToken.None);

        await Until(() => _engine.IsTesting("f1"), "the test to be going while the dial is held");
        Assert.False(testing.IsCompleted);

        dial.SetResult();
        Assert.NotNull((await testing.WaitAsync(TimeSpan.FromSeconds(10))).Flow);
    }

    // The engine takes what it is handed in the order it was handed over. Held back for the dial, a start
    // came after the Stop that was meant to end it: the Stop found nothing, was answered "none going", and the
    // test started a moment later and ran on.
    [Fact]
    public async Task A_stop_pressed_while_a_tests_dial_is_held_leaves_no_test_once_the_pump_has_run()
    {
        var dial = HoldTheFirstDial();
        var testing = _sut.TestAsync(Listening(), CancellationToken.None);
        Assert.False(testing.IsCompleted);

        _sut.StopTest("f1");
        dial.SetResult();
        await testing.WaitAsync(TimeSpan.FromSeconds(10));

        Run();

        // Answered once the engine runs it, so by then the engine has run everything handed over before it.
        await _sut.SaveAsync(Good("later", enabled: false), CancellationToken.None);
        Assert.False(_engine.IsTesting("f1"));
    }

    // The same for a delete, whose Stop is the only thing that takes the test of a deleted flow away: that
    // test waits at an MQTT in, so nothing else ever ends it.
    [Fact]
    public async Task A_delete_pressed_while_a_tests_dial_is_held_leaves_no_test()
    {
        Run();
        _store.Flows = [Listening()];
        var dial = HoldTheFirstDial();
        var testing = _sut.TestAsync(Listening(), CancellationToken.None);
        Assert.False(testing.IsCompleted);

        Assert.True(await _sut.DeleteAsync("f1", CancellationToken.None));
        dial.SetResult();
        await testing.WaitAsync(TimeSpan.FromSeconds(10));

        await _sut.SaveAsync(Good("later", enabled: false), CancellationToken.None);
        Assert.False(_engine.IsTesting("f1"));
    }

    // Of two drafts of one flow the one pressed last is the test. The second Test finds the link being dialled
    // and is through at once; handed over after the first's dial, it was the first's draft that replaced it.
    [Fact]
    public async Task A_second_test_pressed_while_the_first_ones_dial_is_held_leaves_the_second_draft_as_the_test()
    {
        var dial = HoldTheFirstDial();
        var first = _sut.TestAsync(Listening(filter: "plant/k1/first"), CancellationToken.None);
        Assert.False(first.IsCompleted);

        await _sut.TestAsync(Listening(filter: "plant/k1/second"), CancellationToken.None);
        dial.SetResult();
        await first.WaitAsync(TimeSpan.FromSeconds(10));

        // Run with both handed over, so the first draft is never started and then replaced: what the test
        // is made of is all that is left to read.
        Run();
        await Eventually.Until(_time, () => TestRun("f1")?.Waiting is not null, "the test to be waiting");

        Assert.Equal("plant/k1/second", TestRun("f1")!.Waiting!.Filter);
    }

    // ---- what takes a test away, and how many there can be ----

    /// <summary>The flow's test run as the engine last pushed it, or null when it has none.</summary>
    private FlowRunStatus? TestRun(string id) =>
        _engine.Status.Runs.FirstOrDefault(run => run.FlowId == id && run.Kind == FlowRunKind.Test);

    // The console deletes a draft that was never saved here as well. Answered "no such flow", its test ran
    // on — in every status push, with its compiled flow, its variables and its counters — until a restart.
    [Fact]
    public async Task Deleting_a_flow_that_was_never_saved_takes_its_test_away()
    {
        Run();
        await _sut.TestAsync(Listening(), CancellationToken.None);
        await Eventually.Until(_time, () => TestRun("f1") is not null, "the test to be pushed");

        Assert.False(await _sut.DeleteAsync("f1", CancellationToken.None));

        await Eventually.Until(_time, () => !_engine.IsTesting("f1") && TestRun("f1") is null, "the test to be taken away");
    }

    // A test that has ended stays to be read — where it ended, what each node did — until something takes
    // it away. A stop does, and still answers that no test was going.
    [Fact]
    public async Task Stopping_a_test_that_has_ended_takes_it_away()
    {
        Run();
        await _sut.TestAsync(Good(), CancellationToken.None);
        await Eventually.Until(_time, () => TestRun("f1")?.State == FlowRunState.Finished, "the test to finish");

        Assert.False(_sut.StopTest("f1"));

        await Eventually.Until(_time, () => TestRun("f1") is null, "the ended test to be taken away");
    }

    // Until the pump has started it, nothing says the test is going. The stop is handed over all the same,
    // and the pump reaches it after the start, or in its place.
    [Fact]
    public async Task A_stop_right_after_a_test_leaves_no_test_once_the_pump_has_run()
    {
        await _sut.TestAsync(Listening(), CancellationToken.None);
        Assert.False(_sut.StopTest("f1"));

        Run();

        // Answered once the engine runs it, so by then the engine has run everything handed over before it.
        await _sut.SaveAsync(Good("later", enabled: false), CancellationToken.None);
        Assert.False(_engine.IsTesting("f1"));
    }

    [Fact]
    public async Task A_fifty_first_test_is_refused_and_one_of_the_fifty_can_still_be_tested_again()
    {
        Run();
        for (var i = 0; i < FlowLimits.Flows; i++) await _sut.TestAsync(Listening($"t{i}"), CancellationToken.None);
        await Until(() => Enumerable.Range(0, FlowLimits.Flows).All(i => _engine.IsTesting($"t{i}")), "fifty tests to be going");

        var refused = await _sut.TestAsync(Listening("one-too-many"), CancellationToken.None);

        Assert.Null(refused.Flow);
        var problem = Assert.Single(refused.Problems);
        Assert.Equal("flow", problem.Key);
        Assert.Equal("At most 50 tests can run at once. Stop one first.", problem.Message);

        // A test of one of the fifty takes its own one's place, and is not one more.
        Assert.NotNull((await _sut.TestAsync(Listening("t3"), CancellationToken.None)).Flow);
    }

    // What the pump last said was going is where it was until it has been to the starts it was handed, and a
    // pump held up — by an alarm channel slow to answer, or a broker slow with a SUBSCRIBE — does not go. Every
    // Test for a new id used to pass that check and park its compiled flow in a slot of its own, with nothing
    // to stop them at fifty.
    [Fact]
    public async Task A_fifty_first_test_is_refused_while_the_pump_is_held_up_and_fifty_wait_for_it()
    {
        for (var i = 0; i < FlowLimits.Flows; i++)
            Assert.NotNull((await _sut.TestAsync(Listening($"t{i}"), CancellationToken.None)).Flow);

        var refused = await _sut.TestAsync(Listening("one-too-many"), CancellationToken.None);

        Assert.Null(refused.Flow);
        Assert.Equal("At most 50 tests can run at once. Stop one first.", Assert.Single(refused.Problems).Message);

        // A test of one of the fifty takes the place of the start that waits, and is not one more.
        Assert.NotNull((await _sut.TestAsync(Listening("t3"), CancellationToken.None)).Flow);

        // Fifty are what the pump finds when it is free, and the one that was refused is not among them.
        Run();
        await Until(() => Enumerable.Range(0, FlowLimits.Flows).All(i => _engine.IsTesting($"t{i}")), "fifty tests to be going");
        Assert.False(_engine.IsTesting("one-too-many"));
    }

    // A flow with a test going and a start waiting to take its place is one test, not two: counted twice, the
    // second press of one of forty-nine would have left no place for a fiftieth flow that had one.
    [Fact]
    public async Task A_test_pressed_again_while_the_pump_is_held_up_is_counted_once()
    {
        Run();
        for (var i = 0; i < FlowLimits.Flows - 1; i++) await _sut.TestAsync(Listening($"t{i}"), CancellationToken.None);
        await Until(() => Enumerable.Range(0, FlowLimits.Flows - 1).All(i => _engine.IsTesting($"t{i}")), "forty-nine tests to be going");

        // The pump held up in the middle of a turn, by a log slow to take the alarm a flow raises as it starts.
        var told = new TaskCompletionSource();
        _alarms.RaisedAsync(Arg.Any<IReadOnlyList<Alert>>()).Returns(told.Task);
        await _sut.SaveAsync(Ringing("alarm"), CancellationToken.None);
        await Until(() => _alarms.ReceivedCalls().Any(), "the pump to be held up telling the alarm");

        try
        {
            Assert.NotNull((await _sut.TestAsync(Listening("t3"), CancellationToken.None)).Flow);
            Assert.NotNull((await _sut.TestAsync(Listening("the-fiftieth"), CancellationToken.None)).Flow);
            Assert.Null((await _sut.TestAsync(Listening("one-too-many"), CancellationToken.None)).Flow);
        }
        finally
        {
            told.SetResult();
        }
    }
}
