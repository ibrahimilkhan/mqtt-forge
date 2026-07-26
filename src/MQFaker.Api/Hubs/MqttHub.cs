using Microsoft.AspNetCore.SignalR;

namespace MQFaker.Api.Hubs;

// Panelin canlı mesaj akışı için bağlandığı kanal. Sunucudan istemciye tek yönlü
// yayın yapar; istemciden çağrılabilecek bir metodu bilinçli olarak yoktur.
public sealed class MqttHub : Hub;
