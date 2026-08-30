using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;
using MqttForge.Api.Hubs;
using MqttForge.Api.Realtime;
using MqttForge.Application.Alerts;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;
using NSubstitute;
using NSubstitute.ExceptionExtensions;

namespace MqttForge.UnitTests.Api;

public class FanOutMessageNotifierTests
{
    private static readonly MqttMessage Arrival = new(
        "plant/boiler/temp", "94.2", "text", Qos: 0, Retain: false,
        ReceivedAt: new DateTimeOffset(2026, 8, 30, 9, 0, 0, TimeSpan.Zero));

    private static IMessageNotifier Target() => Substitute.For<IMessageNotifier>();

    [Fact]
    public async Task Every_target_is_handed_the_message()
    {
        var first = Target();
        var second = Target();
        var sut = new FanOutMessageNotifier([first, second]);

        await sut.NotifyMessageReceivedAsync(Arrival);

        await first.Received(1).NotifyMessageReceivedAsync(Arrival);
        await second.Received(1).NotifyMessageReceivedAsync(Arrival);
        Assert.Equal(0, sut.Faults);
    }

    // The console and the engine are strangers to each other, and neither of them is why the
    // broker connection exists. A rule set that puts the engine on the floor must not also stop
    // the log drawing itself.
    [Fact]
    public async Task A_target_that_throws_does_not_stop_the_next_one()
    {
        var broken = Target();
        broken.NotifyMessageReceivedAsync(Arg.Any<MqttMessage>())
            .Throws(new InvalidOperationException("the engine fell over"));
        var healthy = Target();
        var sut = new FanOutMessageNotifier([broken, healthy]);

        await sut.NotifyMessageReceivedAsync(Arrival);

        await healthy.Received(1).NotifyMessageReceivedAsync(Arrival);
        Assert.Equal(1, sut.Faults);
    }

    // Where the exception would land if it were rethrown is MQTTnet's receive handler, where it
    // means "this connection had a problem" — which would be a lie about the broker.
    [Fact]
    public async Task A_target_that_throws_never_reaches_the_caller()
    {
        var broken = Target();
        broken.NotifyMessageReceivedAsync(Arg.Any<MqttMessage>())
            .Throws(new InvalidOperationException("the engine fell over"));
        var sut = new FanOutMessageNotifier([broken]);

        var exception = await Record.ExceptionAsync(() => sut.NotifyMessageReceivedAsync(Arrival));

        Assert.Null(exception);
    }

    // Same fault, one layer further out: a target that returns rather than throws, handing back
    // a task that has already failed. Counted the same way, and observed rather than left to
    // resurface as an unobserved task exception long after the message that caused it.
    [Fact]
    public async Task A_target_that_hands_back_a_broken_task_is_counted_rather_than_rethrown()
    {
        var broken = Target();
        broken.NotifyMessageReceivedAsync(Arg.Any<MqttMessage>())
            .Returns(Task.FromException(new IOException("the queue is gone")));
        var healthy = Target();
        var sut = new FanOutMessageNotifier([broken, healthy]);

        var exception = await Record.ExceptionAsync(() => sut.NotifyMessageReceivedAsync(Arrival));

        Assert.Null(exception);
        await healthy.Received(1).NotifyMessageReceivedAsync(Arrival);
        Assert.Equal(1, sut.Faults);
    }

    // The policy in one test: the fan-out is already finished while a target still is not. Both
    // real targets return as soon as they have written to their channel, so a target that hangs
    // is a broken one — and a broken one must not become the broker connection's pace.
    [Fact]
    public async Task A_target_that_never_finishes_does_not_hold_up_the_next_one()
    {
        var stuck = new TaskCompletionSource();
        var slow = Target();
        slow.NotifyMessageReceivedAsync(Arg.Any<MqttMessage>()).Returns(stuck.Task);
        var healthy = Target();
        var sut = new FanOutMessageNotifier([slow, healthy]);

        var handed = sut.NotifyMessageReceivedAsync(Arrival);

        Assert.True(handed.IsCompletedSuccessfully);
        await healthy.Received(1).NotifyMessageReceivedAsync(Arrival);
        Assert.Equal(0, sut.Faults);

        stuck.SetResult();
    }

    // The two-argument constructor is the one DI uses and the only place the console and the
    // engine are named together, so it needs a test of its own. Neither of them publishes what
    // is in its queue, but both publish what fell out of it: handing over one more message than
    // either queue can hold, and finding drops on both sides, says every message reached both.
    [Fact]
    public async Task The_console_and_the_engine_are_both_real_targets()
    {
        var console = new SignalRMessageNotifier(Substitute.For<IHubContext<MqttHub>>());
        var engine = Engine();
        var sut = new FanOutMessageNotifier(console, engine);

        var overflow = Math.Max(SignalRMessageNotifier.QueueCapacity, AlertEngine.QueueCapacity) + 1;
        for (var i = 0; i < overflow; i++) await sut.NotifyMessageReceivedAsync(Arrival);

        Assert.True(console.Dropped > 0, "the console was never handed the messages");
        Assert.True(engine.Dropped > 0, "the engine was never handed the messages");
    }

    // A real engine over substitutes, never started: the queue exists from construction and
    // Dropped is the only thing this test reads off it.
    private static AlertEngine Engine()
    {
        var rules = Substitute.For<IAlertRuleStore>();
        rules.LoadAsync(Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new AlertRuleDocument([], false, [])));

        var state = Substitute.For<IAlertStateStore>();
        state.LoadAsync(Arg.Any<CancellationToken>()).Returns(Task.FromResult<AlertState?>(null));

        return new AlertEngine(
            new AlertEngineCore(new AlertEngineOptions()),
            rules,
            state,
            Substitute.For<IAlertNotifier>(),
            Substitute.For<IMqttConnectionManager>(),
            Substitute.For<IMqttSubscriber>(),
            Substitute.For<ILogger<AlertEngine>>());
    }
}
