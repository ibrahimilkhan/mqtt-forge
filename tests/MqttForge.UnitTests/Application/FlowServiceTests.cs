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
    private readonly IAlertDispatcher _dispatcher = Substitute.For<IAlertDispatcher>();
    private readonly CancellationTokenSource _stop = new();
    private readonly FlowEngine _engine;
    private readonly FlowService _sut;
    private Task? _pump;

    public FlowServiceTests()
    {
        _engine = new FlowEngine(new FlowRuntime(), _store, Substitute.For<IAlertNotifier>(),
            Substitute.For<IFlowNotifier>(), new FakeConnection(), new RecordingSubscriber(), new RecordingPublisher(),
            new AlertEngineOptions(), NullLogger<FlowEngine>.Instance, _time, _dispatcher);
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
        var flow = new FlowBuilder(id).Node("n1", "debug").Build();
        return flow with { Enabled = enabled };
    }

    /// <summary>A flow with a button, so whether the engine is running it is one question away.</summary>
    private static Flow Pressed(string id = "f1") => new FlowBuilder(id).Node("go", "inject").Build();

    /// <summary>A button whose alarm leaves by webhook, so the turn that raises it waits on the dispatcher.</summary>
    private static Flow Ringing(string id = "f1") => new FlowBuilder(id)
        .Node("go", "inject", new { topic = "plant/k1/button", payload = "1" })
        .Node("ring", "alarm", new { name = "Pressed", severity = "warn", webhook = "https://hooks.example.com/pressed" })
        .Wire("go", "out", "ring", "raise")
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
        var result = await _sut.SaveAsync(new FlowBuilder().Node("n1", "teleport").Build(), CancellationToken.None);

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
        _store.Flows = [Good(), new FlowBuilder("bad").Node("n1", "teleport").Build()];

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

    [Fact]
    public void Inject_refuses_what_is_not_running() =>
        Assert.False(_sut.Inject("f1", "go"));

    // ---- what a deploy's answer means ----

    // The flows page presses a new Inject node's button the moment Deploy comes back. The answer has
    // to mean the engine is running what was deployed, or that press is a 404 for a flow on screen.
    [Fact]
    public async Task A_deploy_is_answered_once_the_engine_is_running_it()
    {
        var saving = _sut.SaveAsync(Pressed(), CancellationToken.None);

        Assert.False(saving.IsCompleted);

        Run();
        await saving.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.True(_engine.CanInject("f1", "go"));
        Assert.True(_sut.Inject("f1", "go"));
    }

    [Fact]
    public async Task A_delete_is_answered_once_the_engine_has_stopped_the_flow()
    {
        Run();
        await _sut.SaveAsync(Ringing(), CancellationToken.None);

        // The pump held up by a turn telling an alarm to a channel slow to answer: it reaches nothing
        // posted after that until the channel lets it go.
        var sent = new TaskCompletionSource();
        _dispatcher.RaisedAsync(Arg.Any<IReadOnlyList<Alert>>()).Returns(sent.Task);
        Assert.True(_sut.Inject("f1", "go"));
        await Until(() => _dispatcher.ReceivedCalls().Any(), "the pump to be held up telling the alarm");

        // A delete answered before the engine has stopped the flow would leave a button on a deleted
        // flow still pressable.
        var deleting = _sut.DeleteAsync("f1", CancellationToken.None);
        Assert.False(deleting.IsCompleted);
        Assert.True(_engine.CanInject("f1", "go"));

        sent.SetResult();

        Assert.True(await deleting.WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.False(_engine.CanInject("f1", "go"));
    }

    // Bounded: a pump held up — by an alarm channel slow to answer, or a broker slow with a
    // SUBSCRIBE — must not leave the console's Deploy waiting on it. The flow is kept all the same,
    // and runs as soon as the pump is free.
    [Fact]
    public async Task A_deploy_the_engine_is_too_busy_to_take_is_answered_after_a_bounded_wait()
    {
        var saving = _sut.SaveAsync(Pressed(), CancellationToken.None);
        Assert.False(saving.IsCompleted);

        _time.Advance(FlowEngine.DeployPatience);
        var result = await saving.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.NotNull(result.Flow);
        Assert.False(_engine.CanInject("f1", "go"));

        Run();
        await Until(() => _engine.CanInject("f1", "go"), "the flow to run once the pump is free");
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
            await _sut.SaveAsync(Pressed(), client.Token);
        }
        catch (OperationCanceledException)
        {
            // Whatever the answer is, nobody is waiting for it.
        }

        await Until(() => _engine.CanInject("f1", "go"), "the written flow to run");
    }

    // While the answer waits for the engine. The flow is written and runs all the same, and a flow that
    // runs needs the link: a host that dials for its flows has to be asked, whoever stayed to hear.
    [Fact]
    public async Task A_client_that_goes_away_while_its_deploy_waits_still_has_the_link_asked_for()
    {
        using var client = new CancellationTokenSource();
        var saving = _sut.SaveAsync(Pressed(), client.Token);
        Assert.False(saving.IsCompleted);

        await client.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => saving);

        await _link.Received(1).WantedAsync(Arg.Is<CancellationToken>(ct => !ct.IsCancellationRequested));
    }

    [Fact]
    public async Task A_client_that_goes_away_once_its_flow_is_deleted_still_has_it_stopped()
    {
        Run();
        await _sut.SaveAsync(Pressed(), CancellationToken.None);
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

        await Until(() => !_engine.CanInject("f1", "go"), "the deleted flow to stop");
    }
}
