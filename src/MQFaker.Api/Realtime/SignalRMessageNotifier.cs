using Microsoft.AspNetCore.SignalR;
using MQFaker.Api.Hubs;
using MQFaker.Domain.Abstractions;
using MQFaker.Domain.Models;

namespace MQFaker.Api.Realtime;

// IMessageNotifier'ın SignalR gerçeklemesi. Tarayıcıya mesaj itmek bir teslimat
// meselesi olduğu için Infrastructure'da değil Api katmanında durur.
public sealed class SignalRMessageNotifier : IMessageNotifier
{
    public const string MessageReceived = "messageReceived";

    private readonly IHubContext<MqttHub> _hub;

    public SignalRMessageNotifier(IHubContext<MqttHub> hub) => _hub = hub;

    public Task NotifyMessageReceivedAsync(MqttMessage message) =>
        _hub.Clients.All.SendAsync(MessageReceived, message);
}
