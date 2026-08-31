using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;
using MqttForge.Api.Contracts;
using MqttForge.Api.Hubs;
using MqttForge.Api.Realtime;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using MqttForge.IntegrationTests.Support;
using NSubstitute;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

/// <summary>
/// A container with no browser on it still says what happened, and a console still gets the event.
/// </summary>
// The bargain the composite exists for. Replacing LoggingAlertNotifier with the SignalR one would
// have made a headless MQTTForge — the deployment this whole feature was written for — evaluate
// rules and tell nobody, which is the spec's own definition of a channel that fails worse than
// one which does not exist.
public class CompositeAlertNotifierTests
{
    private static readonly DateTimeOffset T0 = new(2026, 8, 30, 9, 0, 0, TimeSpan.Zero);

    private static Alert Fired(string? resolvedBy = null) =>
        new("a1", "hot", "Boiler temperature", "plant/boiler/temp", AlertSeverity.Critical,
            FiredAt: T0, LastSeenAt: T0,
            ResolvedAt: resolvedBy is null ? null : T0,
            ResolvedBy: resolvedBy,
            MutedUntil: null, Count: 1, Reason: "94.2 > 90", Value: 94.2,
            Sample: "94.2", Actions: [new ScreenAction()]);

    private readonly RecordingLogger<LoggingAlertNotifier> _lines = new();
    private readonly RecordingLogger<CompositeAlertNotifier> _faults = new();
    private readonly List<AlertDto> _sent = [];

    /// <summary>The composite the container builds: the log, then the hub.</summary>
    private CompositeAlertNotifier CreateSut() =>
        new(new LoggingAlertNotifier(_lines), new SignalRAlertNotifier(Hub()), _faults);

    [Fact]
    public async Task Both_the_log_and_the_console_hear_a_raised_alert()
    {
        await CreateSut().RaisedAsync([Fired()]);

        Assert.Equal(
            "Alert raised [Critical] Boiler temperature on plant/boiler/temp: 94.2 > 90",
            Assert.Single(_lines.Entries).Message);
        Assert.Equal("plant/boiler/temp", Assert.Single(_sent).Topic);
    }

    [Fact]
    public async Task Both_hear_a_resolved_alert_as_well()
    {
        await CreateSut().ResolvedAsync([Fired(resolvedBy: "clear")]);

        Assert.Contains("(clear)", Assert.Single(_lines.Entries).Message);
        Assert.Equal("clear", Assert.Single(_sent).ResolvedBy);
    }

    // The whole reason there is a loop with a catch in it rather than a Task.WhenAll. A hub with a
    // client whose socket has just gone, or a webhook notifier somebody adds later, must not take
    // the container's log down with it — that log is the only record a headless run leaves.
    [Fact]
    public async Task A_notifier_that_throws_does_not_cost_the_one_behind_it()
    {
        var heard = new RecordingNotifier();

        await new CompositeAlertNotifier([new ThrowingNotifier(), heard], _faults)
            .RaisedAsync([Fired()]);

        Assert.Single(heard.Raised);
    }

    // Containment that nobody counts is indistinguishable from a channel which quietly stopped
    // delivering, and 'the alarm never reached the screen' is the failure this feature is about.
    [Fact]
    public async Task What_a_notifier_threw_is_counted_and_said()
    {
        var composite = new CompositeAlertNotifier(
            [new ThrowingNotifier(), new RecordingNotifier()], _faults);

        await composite.RaisedAsync([Fired()]);
        await composite.DroppedAsync(3);

        Assert.Equal(2, composite.Faults);

        var entry = _faults.Entries[0];
        Assert.Equal(LogLevel.Error, entry.Level);
        Assert.Contains(nameof(ThrowingNotifier), entry.Message);
        Assert.NotNull(entry.Exception);
    }

    /// <summary>A hub that keeps the DTOs it was handed, so the console's half can be read.</summary>
    private IHubContext<MqttHub> Hub()
    {
        var proxy = Substitute.For<IClientProxy>();
        proxy
            .SendCoreAsync(Arg.Any<string>(), Arg.Any<object?[]>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                // Indexed after the bang for the same reason the other two hub fakes carry one: the array
                // SendCoreAsync is given is never null, and the pattern below already answers for
                // what is in it.
                if (call.Arg<object?[]>()![0] is AlertDto[] frame) _sent.AddRange(frame);

                return Task.CompletedTask;
            });

        var clients = Substitute.For<IHubClients>();
        clients.All.Returns(proxy);

        var context = Substitute.For<IHubContext<MqttHub>>();
        context.Clients.Returns(clients);

        return context;
    }

    // Both real notifiers are sealed classes that cannot be made to misbehave, so the fault policy
    // can only be tested through the list constructor. That is the second reason it exists.
    private sealed class ThrowingNotifier : IAlertNotifier
    {
        public Task RaisedAsync(IReadOnlyList<Alert> alerts) => throw new InvalidOperationException("no");

        public Task ResolvedAsync(IReadOnlyList<Alert> alerts) => throw new InvalidOperationException("no");

        public Task DroppedAsync(int total) => throw new InvalidOperationException("no");
    }

    private sealed class RecordingNotifier : IAlertNotifier
    {
        public List<Alert> Raised { get; } = [];

        public Task RaisedAsync(IReadOnlyList<Alert> alerts)
        {
            Raised.AddRange(alerts);

            return Task.CompletedTask;
        }

        public Task ResolvedAsync(IReadOnlyList<Alert> alerts) => Task.CompletedTask;

        public Task DroppedAsync(int total) => Task.CompletedTask;
    }
}
