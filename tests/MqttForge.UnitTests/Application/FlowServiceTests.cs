using Microsoft.Extensions.Logging.Abstractions;
using MqttForge.Application.Alerts;
using MqttForge.Application.Flows;
using MqttForge.Application.Services;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;
using MqttForge.UnitTests.Application.Flows;
using NSubstitute;

namespace MqttForge.UnitTests.Application;

public class FlowServiceTests
{
    private readonly FakeFlowStore _store = new();
    private readonly ILinkForRules _link = Substitute.For<ILinkForRules>();
    private readonly FlowEngine _engine;
    private readonly FlowService _sut;

    public FlowServiceTests()
    {
        // Never started: the service only posts to it, and Dropped is how a test sees a post.
        _engine = new FlowEngine(new FlowRuntime(), _store, Substitute.For<IAlertNotifier>(),
            Substitute.For<IFlowNotifier>(), Substitute.For<IMqttConnectionManager>(),
            Substitute.For<IMqttSubscriber>(), Substitute.For<IMqttPublisher>(), new AlertEngineOptions(),
            NullLogger<FlowEngine>.Instance);
        _sut = new FlowService(_store, _engine, _link, new AlertEngineOptions());
    }

    private static Flow Good(string id = "f1", bool enabled = true)
    {
        var flow = new FlowBuilder(id).Node("n1", "debug").Build();
        return flow with { Enabled = enabled };
    }

    [Fact]
    public async Task A_flow_that_compiles_is_kept_and_asks_for_a_link_when_it_is_on()
    {
        var result = await _sut.SaveAsync(Good(), CancellationToken.None);

        Assert.NotNull(result.Flow);
        Assert.Single(_store.Flows);
        await _link.Received(1).WantedAsync(Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task A_flow_that_is_off_is_kept_without_asking_for_a_link()
    {
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
        _store.Flows = [Good()];

        Assert.True(await _sut.DeleteAsync("f1", CancellationToken.None));
        Assert.False(await _sut.DeleteAsync("f1", CancellationToken.None));
    }

    [Fact]
    public void Inject_refuses_what_is_not_running() =>
        Assert.False(_sut.Inject("f1", "go"));
}
