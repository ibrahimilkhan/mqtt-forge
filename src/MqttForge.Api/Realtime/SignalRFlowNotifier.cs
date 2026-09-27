using Microsoft.AspNetCore.SignalR;
using MqttForge.Api.Contracts;
using MqttForge.Api.Hubs;
using MqttForge.Application.Flows;

namespace MqttForge.Api.Realtime;

/// <summary>What the console is told about the flows: what they have done, and their debug lines.</summary>
// No queue of its own, because the flow engine keeps one: it calls this from FlowConsoleSender's
// loop and never from its pump. A send to every console waits on the slowest of them — one that
// has stopped reading holds it until its connection times out — and that holds up that loop and
// nothing else. The loop keeps only the newest status and a few seconds of debug lines meanwhile,
// and its token calls a stuck send off when the engine stops.
public sealed class SignalRFlowNotifier : IFlowNotifier
{
    public const string StatusEvent = "flowStatus";
    public const string DebugEvent = "flowDebug";

    private readonly IHubContext<MqttHub> _hub;

    public SignalRFlowNotifier(IHubContext<MqttHub> hub) => _hub = hub;

    public Task StatusAsync(FlowStatus status, CancellationToken ct) =>
        _hub.Clients.All.SendAsync(StatusEvent, FlowStatusDto.Of(status), ct);

    public Task DebugAsync(IReadOnlyList<FlowDebugEntry> entries, int dropped, CancellationToken ct) =>
        _hub.Clients.All.SendAsync(DebugEvent, entries.Select(FlowDebugDto.Of).ToArray(), dropped, ct);
}
