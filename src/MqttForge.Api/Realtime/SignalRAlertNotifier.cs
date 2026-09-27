using Microsoft.AspNetCore.SignalR;
using MqttForge.Api.Contracts;
using MqttForge.Api.Hubs;
using MqttForge.Application.Alerts;
using MqttForge.Domain.Models;

namespace MqttForge.Api.Realtime;

/// <summary>
/// What the console is told: an alarm started, an alarm stopped, a pair was muted, and the count
/// of what the engine never saw.
/// </summary>
// Delivery concern, so it lives in Api beside SignalRMessageNotifier. It keeps no queue of its own,
// because both engines keep one and call it only from a loop of their own, never from a pump: the
// alert engine from AlertConsoleSender's, the flow engine from FlowConsoleSender's, through
// SignalRFlowNotifier. A send to every console waits on the slowest of them, and one that has
// stopped reading holds it until its connection times out — which holds up that loop, and no rule
// and no flow. Each engine calls a stuck frame off with its token when it stops.
//
// What is kept here is the frame cap, for its own reason: a restart that restores every alarm that
// was ringing hands over one list, and the engine's MaxActiveAlerts ceiling is a thousand.
public sealed class SignalRAlertNotifier : IAlertConsole
{
    public const string AlertsRaised = "alertsRaised";
    public const string AlertsResolved = "alertsResolved";

    /// <summary>The pair and the moment the mute lifts, so the panel can count down alone.</summary>
    public const string AlertMuted = "alertMuted";

    /// <summary>Carries the running total, so the console can say what the engine never judged.</summary>
    public const string AlertsDropped = "alertsDropped";

    /// <summary>A ceiling on one frame, so a full restore is several messages rather than one.</summary>
    // Half the engine's MaxActiveAlerts, so the worst case a restart can produce is two frames the
    // browser can work through instead of one it has to parse whole before it draws a single row.
    public const int MaxBatchSize = 500;

    private readonly IHubContext<MqttHub> _hub;

    // The last total sent, so an engine that is keeping up costs nothing. Not volatile and not
    // interlocked: every call to DroppedAsync comes off AlertConsoleSender's loop, one at a time.
    private int _announced;

    public SignalRAlertNotifier(IHubContext<MqttHub> hub) => _hub = hub;

    public Task RaisedAsync(IReadOnlyList<Alert> alerts, CancellationToken ct) => SendAsync(AlertsRaised, alerts, ct);

    public Task ResolvedAsync(IReadOnlyList<Alert> alerts, CancellationToken ct) => SendAsync(AlertsResolved, alerts, ct);

    /// <summary>
    /// Said by the mute endpoint after it has posted the command, because a mute is something a
    /// person did rather than something a turn of the engine decided. A null
    /// <paramref name="until"/> is the lift: zero minutes, the panel's "Geri al".
    /// </summary>
    // Not on IAlertConsole. That interface is the engine's own way of saying what it judged, and
    // a fourth method about a hub would make every future console implement one. The endpoint
    // resolves this class by its own type, which is how the container registers it.
    //
    // Nullable rather than two methods: the console draws one row either way, and a second event
    // name would be a second thing for the panel to bind and a second thing to forget.
    public Task MutedAsync(string ruleId, string topic, DateTimeOffset? until) =>
        _hub.Clients.All.SendAsync(AlertMuted, ruleId, topic, until);

    // Sent on a change only, which for an engine that is keeping up is never. The engine guards
    // this as well; both guards are wanted, because neither caller of a method like this one should
    // have to know about the other's bookkeeping.
    public async Task DroppedAsync(int total, CancellationToken ct)
    {
        if (total == _announced) return;

        _announced = total;
        await _hub.Clients.All.SendAsync(AlertsDropped, total, ct);
    }

    private async Task SendAsync(string method, IReadOnlyList<Alert> alerts, CancellationToken ct)
    {
        // Nothing to say is no frame at all. An empty frame is a socket kept awake for no reason and
        // a console asked to redraw for no reason.
        if (alerts.Count == 0) return;

        for (var sent = 0; sent < alerts.Count; sent += MaxBatchSize)
        {
            var frame = new AlertDto[Math.Min(MaxBatchSize, alerts.Count - sent)];
            for (var i = 0; i < frame.Length; i++) frame[i] = AlertDto.Of(alerts[sent + i]);

            // Awaited in order. Frames of one restore arriving out of order would have the panel
            // drawing the second half of an alarm list before the first.
            await _hub.Clients.All.SendAsync(method, frame, ct);
        }
    }
}
