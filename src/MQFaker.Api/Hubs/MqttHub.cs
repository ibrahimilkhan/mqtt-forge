using Microsoft.AspNetCore.SignalR;

namespace MQFaker.Api.Hubs;

// The channel the console connects to for the live message stream. Broadcasts one way,
// server to client; it deliberately exposes no client-callable method.
public sealed class MqttHub : Hub;
