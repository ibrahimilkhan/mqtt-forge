using Microsoft.AspNetCore.SignalR;
using MqttForge.Api.Contracts;
using MqttForge.Api.Hubs;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;

namespace MqttForge.Api.Realtime;

// Same shape as GET /api/connection/reconnect, so the console has one thing to learn whether it
// asked or was told.
public sealed class SignalRReconnectStatusNotifier : IReconnectStatusNotifier
{
    public const string ReconnectStatusChanged = "reconnectStatusChanged";

    private readonly IHubContext<MqttHub> _hub;

    public SignalRReconnectStatusNotifier(IHubContext<MqttHub> hub) => _hub = hub;

    public Task NotifyReconnectStatusChangedAsync(ReconnectStatus status) =>
        _hub.Clients.All.SendAsync(ReconnectStatusChanged, ReconnectStatusDto.Of(status));
}
