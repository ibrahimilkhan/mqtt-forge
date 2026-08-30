using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.Api.Realtime;

/// <summary>
/// What a headless container says. Plan 3 replaces this with the SignalR notifier; until then it
/// is the only channel there is.
/// </summary>
// The spec's own measure of a channel is that one which fails silently is worse than one that
// does not exist. A server that evaluated rules and told nobody would fail that measure on its
// first day in Docker, where there is no console to open and no hub client to send to.
//
// Levels come from the severity, and the resolved line takes the same level as the raised one.
// That looks wrong at first — an alert going away is good news — and it is deliberate: a
// raised/resolved pair split across two levels makes "is this still ringing?" unanswerable by
// filtering, which is the only tool a container log has. Both halves at Error means one grep
// shows the whole story.
public sealed class LoggingAlertNotifier : IAlertNotifier
{
    private readonly ILogger<LoggingAlertNotifier> _log;

    public LoggingAlertNotifier(ILogger<LoggingAlertNotifier> log) => _log = log;

    // One line each rather than one line for the batch: a busy second would otherwise become a
    // single line naming one topic and hiding the rest.
    public Task RaisedAsync(IReadOnlyList<Alert> alerts)
    {
        foreach (var alert in alerts)
            _log.Log(LevelFor(alert.Severity),
                "Alert raised [{Severity}] {RuleName} on {Topic}: {Reason}",
                alert.Severity, alert.RuleName, alert.Topic, alert.Reason);

        return Task.CompletedTask;
    }

    // ResolvedBy and not Reason: Reason is the sentence the alert was about and never changes,
    // so why it went away has to be its own field on the line as well as on the record.
    public Task ResolvedAsync(IReadOnlyList<Alert> alerts)
    {
        foreach (var alert in alerts)
            _log.Log(LevelFor(alert.Severity),
                "Alert resolved [{Severity}] {RuleName} on {Topic}: {Reason} ({ResolvedBy})",
                alert.Severity, alert.RuleName, alert.Topic, alert.Reason, alert.ResolvedBy);

        return Task.CompletedTask;
    }

    // The running total, not the increment. "Some messages were dropped" is not something anyone
    // can act on; a number that keeps climbing between two lines is.
    public Task DroppedAsync(int total)
    {
        _log.LogWarning(
            "The alert engine has not seen {Dropped} messages: its queue was full.", total);

        return Task.CompletedTask;
    }

    private static LogLevel LevelFor(AlertSeverity severity) => severity switch
    {
        AlertSeverity.Critical => LogLevel.Error,
        AlertSeverity.Warn => LogLevel.Warning,
        _ => LogLevel.Information
    };
}
