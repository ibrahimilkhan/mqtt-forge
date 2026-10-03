using Microsoft.AspNetCore.SignalR;
using MqttForge.Api.Contracts;
using MqttForge.Api.Hubs;
using MqttForge.Application.Flows;
using MqttForge.Domain.Models;

namespace MqttForge.Api.Realtime;

/// <summary>What the console is told about the flows: their runs, their debug lines, their alarms, tones and notices.</summary>
// No queue of its own, because the flow engine keeps one: it calls this from FlowConsoleSender's
// loop and never from its pump. A send to every console waits on the slowest of them — one that
// has stopped reading holds it until its connection times out — and that holds up that loop and
// nothing else. The loop keeps only the newest status, a few seconds of debug lines, the alarms in
// their order and the newest tones and notices meanwhile, and its token calls a stuck send off when
// the engine stops.
//
// A flow alarm is told as a rule's is, as alertsRaised and alertsResolved, so the badge and the alarm
// list need nothing of their own for it — through SignalRAlertNotifier, which is where an alarm becomes
// a frame, and with this loop's token. A tone and a notice are a Sound's and a Notify's, steps a flow
// takes when it chooses, and have events of their own.
public sealed class SignalRFlowNotifier : IFlowNotifier
{
    public const string StatusEvent = "flowStatus";
    public const string DebugEvent = "flowDebug";
    public const string SoundEvent = "flowSound";
    public const string NoticeEvent = "flowNotice";

    private readonly IHubContext<MqttHub> _hub;
    private readonly SignalRAlertNotifier _alarms;

    public SignalRFlowNotifier(IHubContext<MqttHub> hub, SignalRAlertNotifier alarms)
    {
        _hub = hub;
        _alarms = alarms;
    }

    public Task StatusAsync(FlowStatus status, CancellationToken ct) =>
        _hub.Clients.All.SendAsync(StatusEvent, FlowStatusDto.Of(status), ct);

    public Task DebugAsync(IReadOnlyList<FlowDebugEntry> entries, int dropped, CancellationToken ct) =>
        _hub.Clients.All.SendAsync(DebugEvent, entries.Select(FlowDebugDto.Of).ToArray(), dropped, ct);

    public Task RaisedAsync(IReadOnlyList<Alert> alerts, CancellationToken ct) => _alarms.RaisedAsync(alerts, ct);

    public Task ResolvedAsync(IReadOnlyList<Alert> alerts, CancellationToken ct) => _alarms.ResolvedAsync(alerts, ct);

    public Task SoundsAsync(IReadOnlyList<FlowSound> sounds, CancellationToken ct) =>
        _hub.Clients.All.SendAsync(SoundEvent, sounds.Select(FlowSoundDto.Of).ToArray(), ct);

    public Task NoticesAsync(IReadOnlyList<FlowNotice> notices, CancellationToken ct) =>
        _hub.Clients.All.SendAsync(NoticeEvent, notices.Select(FlowNoticeDto.Of).ToArray(), ct);
}
