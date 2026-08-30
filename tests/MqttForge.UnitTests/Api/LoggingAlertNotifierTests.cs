using Microsoft.Extensions.Logging;
using MqttForge.Api.Realtime;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Api;

public class LoggingAlertNotifierTests
{
    private readonly RecordingLogger<LoggingAlertNotifier> _log = new();

    private LoggingAlertNotifier CreateSut() => new(_log);

    private static readonly DateTimeOffset T0 = new(2026, 8, 30, 9, 0, 0, TimeSpan.Zero);

    private static Alert Fired(
        AlertSeverity severity = AlertSeverity.Critical,
        string reason = "94.2 > 90",
        string? resolvedBy = null,
        string topic = "plant/boiler/temp",
        string ruleName = "Boiler temperature") =>
        new("a1", "r1", ruleName, topic, severity,
            FiredAt: T0, LastSeenAt: T0,
            ResolvedAt: resolvedBy is null ? null : T0,
            ResolvedBy: resolvedBy,
            MutedUntil: null, Count: 1, Reason: reason, Value: 94.2,
            Sample: "{\"temp\":94.2}", Actions: [new ScreenAction()]);

    [Fact]
    public async Task A_critical_alert_is_logged_as_an_error()
    {
        await CreateSut().RaisedAsync([Fired(AlertSeverity.Critical)]);

        Assert.Equal(LogLevel.Error, Assert.Single(_log.Entries).Level);
    }

    [Fact]
    public async Task A_warning_alert_is_logged_as_a_warning()
    {
        await CreateSut().RaisedAsync([Fired(AlertSeverity.Warn)]);

        Assert.Equal(LogLevel.Warning, Assert.Single(_log.Entries).Level);
    }

    [Fact]
    public async Task An_info_alert_is_logged_as_information()
    {
        await CreateSut().RaisedAsync([Fired(AlertSeverity.Info)]);

        Assert.Equal(LogLevel.Information, Assert.Single(_log.Entries).Level);
    }

    // The four things a person needs to act, in one line: how loud, which rule, which topic, and
    // the sentence the engine wrote. Asserted whole rather than piecemeal, because the order of
    // these is what makes a wall of container output scannable.
    [Fact]
    public async Task A_raised_line_names_the_severity_the_rule_the_topic_and_the_reason()
    {
        await CreateSut().RaisedAsync([Fired()]);

        Assert.Equal(
            "Alert raised [Critical] Boiler temperature on plant/boiler/temp: 94.2 > 90",
            Assert.Single(_log.Entries).Message);
    }

    [Fact]
    public async Task A_resolved_line_says_what_let_the_alert_go()
    {
        await CreateSut().ResolvedAsync([Fired(resolvedBy: "clear")]);

        Assert.Equal(
            "Alert resolved [Critical] Boiler temperature on plant/boiler/temp: 94.2 > 90 (clear)",
            Assert.Single(_log.Entries).Message);
    }

    // Deliberately not Information. A raised/resolved pair split across two levels makes "is this
    // still ringing?" unanswerable by filtering, which is the only tool a container log has.
    [Fact]
    public async Task A_resolved_alert_is_logged_at_the_level_its_severity_asked_for()
    {
        await CreateSut().ResolvedAsync([Fired(AlertSeverity.Critical, resolvedBy: "clear")]);

        Assert.Equal(LogLevel.Error, Assert.Single(_log.Entries).Level);
    }

    // The engine hands over a tick's worth at a time. One line each, or a busy second becomes a
    // single line that names one topic and hides the rest.
    [Fact]
    public async Task Every_alert_in_a_batch_gets_its_own_line()
    {
        await CreateSut().RaisedAsync([
            Fired(topic: "plant/boiler/temp"),
            Fired(AlertSeverity.Warn, topic: "plant/pump/temp")
        ]);

        Assert.Equal(2, _log.Entries.Count);
        Assert.Contains("plant/boiler/temp", _log.Entries[0].Message);
        Assert.Contains("plant/pump/temp", _log.Entries[1].Message);
    }

    // A tick with nothing to say says nothing. The engine calls this on every turn it changed
    // anything, and a "0 alerts raised" line every second would bury the ones that matter.
    [Fact]
    public async Task An_empty_batch_writes_nothing()
    {
        var sut = CreateSut();

        await sut.RaisedAsync([]);
        await sut.ResolvedAsync([]);

        Assert.Empty(_log.Entries);
    }

    // The one number the engine cannot infer from anything it did: messages it never saw. A
    // warning, and it names the running total, because 'some were dropped' is not actionable.
    [Fact]
    public async Task Dropped_messages_are_a_warning_that_names_the_total()
    {
        await CreateSut().DroppedAsync(12);

        var entry = Assert.Single(_log.Entries);
        Assert.Equal(LogLevel.Warning, entry.Level);
        Assert.Contains("12", entry.Message);
    }
}
