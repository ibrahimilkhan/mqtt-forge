using Microsoft.AspNetCore.SignalR;
using MQFaker.Api.Hubs;
using MQFaker.Domain.Abstractions;
using MQFaker.Domain.Enums;

namespace MQFaker.Api.Realtime;

// SignalR implementation of IConnectionStateNotifier. The console reads the state as a
// string, the same shape GET /api/connection returns, so both paths look alike.
public sealed class SignalRConnectionStateNotifier : IConnectionStateNotifier
{
    public const string ConnectionStateChanged = "connectionStateChanged";

    private readonly IHubContext<MqttHub> _hub;

    public SignalRConnectionStateNotifier(IHubContext<MqttHub> hub) => _hub = hub;

    public Task NotifyStateChangedAsync(ConnectionState state) =>
        _hub.Clients.All.SendAsync(ConnectionStateChanged, new { state = state.ToString() });
}
