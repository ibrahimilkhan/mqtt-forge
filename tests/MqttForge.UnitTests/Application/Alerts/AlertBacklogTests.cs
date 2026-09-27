using MqttForge.Application.Alerts;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Alerts;

// What a channel slow to take its alerts is still handed once it takes again. A bound of ten here,
// where the console's and the broker's are thousands: the arithmetic is the same, and a test that
// has to fill a real one says nothing more.
public class AlertBacklogTests
{
    private static readonly DateTimeOffset T0 = new(2026, 9, 27, 9, 0, 0, TimeSpan.Zero);

    private const int Bound = 10;

    private static Alert Alert(string id) => new(id, "hot", "Boiler temperature", $"plant/{id}/temp",
        AlertSeverity.Critical, FiredAt: T0, LastSeenAt: T0, ResolvedAt: null, ResolvedBy: null,
        MutedUntil: null, Count: 1, Reason: "94.2 > 90", Value: 94.2, Sample: null, Actions: [new ScreenAction()]);

    private static AlertEvent Up(string id) => new(Alert(id), Raised: true);

    private static AlertEvent Down(string id) => new(Alert(id) with { ResolvedAt = T0, ResolvedBy = "clear" }, Raised: false);

    private static IEnumerable<string> Lines(AlertBacklog.Taken taken) =>
        taken.Events.Select(one => $"{(one.Raised ? "up" : "down")} {one.Alert.Id}");

    [Fact]
    public void Nothing_waiting_is_nothing_to_take()
    {
        Assert.Null(new AlertBacklog(Bound).Take());
    }

    // Within the bound nothing is let go: a channel that keeps up hears both ends of an alert that
    // stood for no time at all.
    [Fact]
    public void Within_the_bound_every_event_is_handed_over_in_its_order_however_briefly_its_alert_stood()
    {
        var backlog = new AlertBacklog(Bound);

        backlog.Add([Up("a"), Down("a")]);
        backlog.Add([Up("b")]);

        var taken = backlog.Take()!.Value;
        Assert.Equal(["up a", "down a", "up b"], Lines(taken));
        Assert.Equal(0, taken.Untold);
        Assert.Null(backlog.Take());
    }

    // What the channel still needs once too many are waiting: every alert standing, and the end of
    // every alert whose raise it already has. An alert that went up and came down meanwhile it was
    // never told of, and never needs to be.
    [Fact]
    public void Past_the_bound_the_alerts_that_came_and_went_go_both_ends_and_the_rest_keep_their_order()
    {
        var backlog = new AlertBacklog(Bound);

        var waiting = new List<AlertEvent> { Down("told-1") };
        for (var i = 0; i < Bound; i++) waiting.AddRange([Up($"brief-{i}"), Down($"brief-{i}")]);
        waiting.AddRange([Up("standing"), Down("told-2")]);
        backlog.Add(waiting);

        var taken = backlog.Take()!.Value;
        Assert.Equal(["down told-1", "up standing", "down told-2"], Lines(taken));
        Assert.Equal(Bound, taken.Untold);
        Assert.Equal(0, taken.Lost);
    }

    // A bound that holds whatever it is handed. No engine keeping its ceiling can get here, so this
    // hands the backlog what none would: ends of alerts whose raises were taken, more than the bound.
    [Fact]
    public void Past_the_bound_whatever_it_is_handed_the_oldest_go_and_are_counted()
    {
        var backlog = new AlertBacklog(Bound);

        backlog.Add([.. Enumerable.Range(0, Bound + 5).Select(i => Down($"gone-{i}"))]);

        var taken = backlog.Take()!.Value;
        Assert.Equal(Bound, taken.Events.Count);
        Assert.Equal("gone-5", taken.Events[0].Alert.Id);
        Assert.Equal(5, taken.Lost);
    }

    // What was let go is said once, with the next take, even when nothing else is left to hand over.
    [Fact]
    public void What_was_let_go_is_handed_over_once_even_with_nothing_left_waiting()
    {
        var backlog = new AlertBacklog(Bound);

        backlog.Add([.. Enumerable.Range(0, Bound).SelectMany(i => new[] { Up($"brief-{i}"), Down($"brief-{i}") })]);

        var taken = backlog.Take()!.Value;
        Assert.Empty(taken.Events);
        Assert.Equal(Bound, taken.Untold);
        Assert.Null(backlog.Take());
    }
}
