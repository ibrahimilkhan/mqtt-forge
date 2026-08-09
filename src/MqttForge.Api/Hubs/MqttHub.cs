using Microsoft.AspNetCore.SignalR;

namespace MqttForge.Api.Hubs;

// One-way broadcast channel; deliberately exposes no client-callable method
public sealed class MqttHub : Hub;
