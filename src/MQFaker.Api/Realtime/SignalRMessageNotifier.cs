using Microsoft.AspNetCore.SignalR;
using MQFaker.Api.Hubs;
using MQFaker.Domain.Abstractions;
using MQFaker.Domain.Models;

namespace MQFaker.Api.Realtime;

// SignalR implementation of IMessageNotifier. Pushing messages to the browser is a
// delivery concern, so it lives in the Api layer rather than Infrastructure.
public sealed class SignalRMessageNotifier : IMessageNotifier
{
    public const string MessageReceived = "messageReceived";

    private readonly IHubContext<MqttHub> _hub;

    public SignalRMessageNotifier(IHubContext<MqttHub> hub) => _hub = hub;

    public Task NotifyMessageReceivedAsync(MqttMessage message) =>
        _hub.Clients.All.SendAsync(MessageReceived, message);
}
