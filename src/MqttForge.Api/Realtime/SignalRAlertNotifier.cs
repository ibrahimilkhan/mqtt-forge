using Microsoft.AspNetCore.SignalR;
using MqttForge.Api.Contracts;
using MqttForge.Api.Hubs;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;

namespace MqttForge.Api.Realtime;

/// <summary>
/// What the console is told: an alarm started, an alarm stopped, a pair was muted, and the count
/// of what the engine never saw.
/// </summary>
// Delivery concern, so it lives in Api beside SignalRMessageNotifier — and it is deliberately not
// built like it. That class has a queue and a pump because its caller is MQTTnet's own receive
// handler, where a wait is a wait on the broker connection itself; its comment says exactly that.
// This class is called from AlertEngine.DeliverAsync, on the engine's own pump, which has already
// finished judging by the time it gets here and whose other work is a one-second tick.
//
// A queue of its own would buy nothing and cost something. It would add a second place an alert
// can be dropped, and an alarm dropped on the way to the screen is the silent failure this whole
// feature exists to prevent. A late frame is the better of the two.
//
// What is kept is the frame cap, for its own reason: a restart that restores every alarm that was
// ringing hands over one list, and the engine's MaxActiveAlerts ceiling is a thousand.
public sealed class SignalRAlertNotifier : IAlertNotifier
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
    // interlocked: every call into this class comes off AlertEngine's pump, which is one thread.
    private int _announced;

    public SignalRAlertNotifier(IHubContext<MqttHub> hub) => _hub = hub;

    public Task RaisedAsync(IReadOnlyList<Alert> alerts) => SendAsync(AlertsRaised, alerts);

    public Task ResolvedAsync(IReadOnlyList<Alert> alerts) => SendAsync(AlertsResolved, alerts);

    /// <summary>
    /// Said by the mute endpoint after it has posted the command, because a mute is something a
    /// person did rather than something a turn of the engine decided. A null
    /// <paramref name="until"/> is the lift: zero minutes, the panel's "Geri al".
    /// </summary>
    // Not on IAlertNotifier. That interface is the engine's own way of saying what it judged, and
    // a fourth method about a hub would make every future notifier implement one. The endpoint
    // resolves this class by its own type, which is how the container registers it.
    //
    // Nullable rather than two methods: the console draws one row either way, and a second event
    // name would be a second thing for the panel to bind and a second thing to forget.
    public Task MutedAsync(string ruleId, string topic, DateTimeOffset? until) =>
        _hub.Clients.All.SendAsync(AlertMuted, ruleId, topic, until);

    // Sent on a change only, which for an engine that is keeping up is never. The engine guards
    // this as well; both guards are wanted, because the composite means this method has more than
    // one possible caller and neither of them should have to know about the other's bookkeeping.
    public async Task DroppedAsync(int total)
    {
        if (total == _announced) return;

        _announced = total;
        await _hub.Clients.All.SendAsync(AlertsDropped, total);
    }

    private async Task SendAsync(string method, IReadOnlyList<Alert> alerts)
    {
        // The engine calls both halves on every turn that changed anything, and most turns change
        // nothing on one of the two lists. An empty frame a second is a socket kept awake for no
        // reason and a console asked to redraw for no reason.
        if (alerts.Count == 0) return;

        for (var sent = 0; sent < alerts.Count; sent += MaxBatchSize)
        {
            var frame = new AlertDto[Math.Min(MaxBatchSize, alerts.Count - sent)];
            for (var i = 0; i < frame.Length; i++) frame[i] = AlertDto.Of(alerts[sent + i]);

            // Awaited in order. Frames of one restore arriving out of order would have the panel
            // drawing the second half of an alarm list before the first.
            await _hub.Clients.All.SendAsync(method, frame);
        }
    }
}
