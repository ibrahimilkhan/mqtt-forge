using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;
using MqttForge.Api.Contracts;
using MqttForge.Api.Controllers;
using MqttForge.Api.Hubs;
using MqttForge.Api.Realtime;
using MqttForge.Application.Alerts;
using MqttForge.Application.Services;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using NSubstitute;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

/// <summary>
/// The mute endpoint's other half: the command goes on the queue, and the consoles are told.
/// </summary>
// AlertEndpointTests already proves the mute is applied, over HTTP, by reading it back out of
// GET /api/alerts. This class is about the thing that read cannot see — whether anything was said
// on the hub — because a MutedAsync with no caller is a method that passes its own tests and
// leaves the panel waiting for its next poll.
//
// The controller is built by hand rather than reached through a host. A mute needs a (rule, topic)
// pair the engine has already seen, and the shortest honest way to that is the core: SetRules, one
// reading, and an AlertEngine wrapped round it, whose constructor publishes the snapshot the
// controller reads. No pump, no broker, no clock to move.
public class AlertMuteAnnouncementTests
{
    private static readonly DateTimeOffset T0 = new(2026, 8, 30, 9, 0, 0, TimeSpan.Zero);

    private const string Boiler = "plant/boiler/temp";

    private readonly List<(string Method, object?[] Arguments)> _sends = [];

    [Fact]
    public async Task Muting_a_pair_tells_the_console_the_pair_and_the_moment_it_lifts()
    {
        var before = DateTimeOffset.UtcNow;

        var answer = await CreateSut().Mute(new MuteRequestDto("hot", Boiler, 30));

        Assert.IsType<NoContentResult>(answer);

        var arguments = Arguments(SignalRAlertNotifier.AlertMuted);

        Assert.Equal(3, arguments.Count);
        Assert.Equal("hot", arguments[0]);
        Assert.Equal(Boiler, arguments[1]);

        // A window rather than a value: the endpoint reads the wall clock, and what matters is
        // that the moment it announced is the same half-hour the core will write.
        var until = Assert.IsType<DateTimeOffset>(arguments[2]);
        Assert.InRange(until, before.AddMinutes(30), DateTimeOffset.UtcNow.AddMinutes(30));
    }

    // The panel's "Geri al". Without this the console that pressed it redraws and the other three
    // go on showing a faded row until their next poll.
    [Fact]
    public async Task Zero_minutes_is_announced_as_a_lift_rather_than_as_a_moment()
    {
        var answer = await CreateSut().Mute(new MuteRequestDto("hot", Boiler, 0));

        Assert.IsType<NoContentResult>(answer);
        Assert.Null(Arguments(SignalRAlertNotifier.AlertMuted)[2]);
    }

    // The announcement is after the 404 check and not before it. A console told that a pair it
    // does not have is now muted would draw a row that nothing can ever un-mute.
    [Fact]
    public async Task A_pair_the_engine_never_saw_is_refused_and_nothing_is_announced()
    {
        var answer = await CreateSut().Mute(new MuteRequestDto("hot", "plant/nobody/temp", 30));

        Assert.Equal(StatusCodes.Status404NotFound, Assert.IsType<ObjectResult>(answer).StatusCode);
        Assert.Empty(_sends);
    }

    /// <summary>A controller whose engine already holds one ringing pair.</summary>
    private AlertController CreateSut()
    {
        var options = new AlertEngineOptions();
        var core = new AlertEngineCore(options);

        core.SetRules([Rule()], T0);
        core.OnMessage(Reading(T0), T0);

        // Seven arguments: the clock and the dispatcher are both left at their defaults, because
        // nothing here starts the pump that would use either.
        var engine = new AlertEngine(
            core,
            Substitute.For<IAlertRuleStore>(),
            Substitute.For<IAlertStateStore>(),
            Substitute.For<IAlertNotifier>(),
            Substitute.For<IMqttConnectionManager>(),
            Substitute.For<IMqttSubscriber>(),
            Substitute.For<ILogger<AlertEngine>>());

        return new AlertController(
            new AlertRuleService(Substitute.For<IAlertRuleStore>(), engine),
            engine,
            options,
            new AlertPanelCounters(),
            new SignalRAlertNotifier(Hub()));
    }

    // The spec's worked example, with the cooldown at zero so that the one reading below is
    // enough to put the pair on the board.
    private static AlertRule Rule() => new(
        "hot", "Boiler temperature", Enabled: true, "plant/+/temp", "$.temp",
        new ThresholdCondition(ThresholdOp.Gt, 90), Clear: null, For: null, Cooldown: 0,
        AlertSeverity.Critical, [new ScreenAction()]);

    private static MqttMessage Reading(DateTimeOffset at) =>
        new(Boiler, "{\"temp\":94.2}", "text", Qos: 0, Retain: false, ReceivedAt: at);

    private IReadOnlyList<object?> Arguments(string method) =>
        [.. _sends.Where(sent => sent.Method == method).SelectMany(sent => sent.Arguments)];

    /// <summary>The same recording hub AlertHubTests uses, kept here so this file stands alone.</summary>
    private IHubContext<MqttHub> Hub()
    {
        var proxy = Substitute.For<IClientProxy>();
        proxy
            .SendCoreAsync(Arg.Any<string>(), Arg.Any<object?[]>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                // See AlertHubTests: NSubstitute types the argument array as nullable and the list does not.
                    _sends.Add((call.ArgAt<string>(0), call.Arg<object?[]>()!));

                return Task.CompletedTask;
            });

        var clients = Substitute.For<IHubClients>();
        clients.All.Returns(proxy);

        var context = Substitute.For<IHubContext<MqttHub>>();
        context.Clients.Returns(clients);

        return context;
    }
}
