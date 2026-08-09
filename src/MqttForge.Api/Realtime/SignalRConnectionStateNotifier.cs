using Microsoft.AspNetCore.SignalR;
using MqttForge.Api.Contracts;
using MqttForge.Api.Hubs;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.Api.Realtime;

// State sent as a string, matching the shape of GET /api/connection
public sealed class SignalRConnectionStateNotifier : IConnectionStateNotifier
{
    public const string ConnectionStateChanged = "connectionStateChanged";

    private readonly IHubContext<MqttHub> _hub;

    public SignalRConnectionStateNotifier(IHubContext<MqttHub> hub) => _hub = hub;

    public Task NotifyStateChangedAsync(ConnectionState state, BrokerFailure? failure, BrokerLink? link) =>
        _hub.Clients.All.SendAsync(
            ConnectionStateChanged,
            new
            {
                state = state.ToString(),
                failure = BrokerFailureDto.Of(failure),
                connection = BrokerLinkDto.Of(link)
            });
}
