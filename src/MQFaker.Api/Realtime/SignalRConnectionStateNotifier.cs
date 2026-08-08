using Microsoft.AspNetCore.SignalR;
using MQFaker.Api.Contracts;
using MQFaker.Api.Hubs;
using MQFaker.Domain.Abstractions;
using MQFaker.Domain.Enums;

namespace MQFaker.Api.Realtime;

// State sent as a string, matching the shape of GET /api/connection
public sealed class SignalRConnectionStateNotifier : IConnectionStateNotifier
{
    public const string ConnectionStateChanged = "connectionStateChanged";

    private readonly IHubContext<MqttHub> _hub;

    public SignalRConnectionStateNotifier(IHubContext<MqttHub> hub) => _hub = hub;

    public Task NotifyStateChangedAsync(ConnectionState state, BrokerFailureReason? failure) =>
        _hub.Clients.All.SendAsync(
            ConnectionStateChanged,
            new { state = state.ToString(), reason = FailureReasonName.Of(failure) });
}
