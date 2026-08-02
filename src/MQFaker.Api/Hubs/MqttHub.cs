using Microsoft.AspNetCore.SignalR;

namespace MQFaker.Api.Hubs;

// One-way broadcast channel; deliberately exposes no client-callable method
public sealed class MqttHub : Hub;
