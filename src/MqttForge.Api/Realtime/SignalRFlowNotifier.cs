using Microsoft.AspNetCore.SignalR;
using MqttForge.Api.Contracts;
using MqttForge.Api.Hubs;
using MqttForge.Application.Flows;

namespace MqttForge.Api.Realtime;

/// <summary>What the console is told about the flows: what they have done, and their debug lines.</summary>
// No queue of its own, for SignalRAlertNotifier's reason: its caller is the flow engine's pump,
// which already throttles to four pushes a second and has nothing else waiting on it.
public sealed class SignalRFlowNotifier : IFlowNotifier
{
    public const string StatusEvent = "flowStatus";
    public const string DebugEvent = "flowDebug";

    private readonly IHubContext<MqttHub> _hub;

    public SignalRFlowNotifier(IHubContext<MqttHub> hub) => _hub = hub;

    public Task StatusAsync(FlowStatus status) =>
        _hub.Clients.All.SendAsync(StatusEvent, FlowStatusDto.Of(status));

    public Task DebugAsync(IReadOnlyList<FlowDebugEntry> entries, int dropped) =>
        _hub.Clients.All.SendAsync(DebugEvent, entries.Select(FlowDebugDto.Of).ToArray(), dropped);
}
