using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.SignalR.Client;
using MqttForge.Api.Contracts;
using MqttForge.IntegrationTests.Support;
using MQTTnet;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

public class SubscriptionEndpointTests : IClassFixture<MqttForgeApiFactory>, IClassFixture<MosquittoFixture>
{
    private readonly MqttForgeApiFactory _factory;
    private readonly MosquittoFixture _broker;

    public SubscriptionEndpointTests(MqttForgeApiFactory factory, MosquittoFixture broker)
    {
        _factory = factory;
        _broker = broker;
    }

    [Fact]
    public async Task Subscribe_with_empty_filter_returns_400()
    {
        var client = _factory.CreateClient();

        var response = await client.PostAsJsonAsync("/api/subscriptions", new SubscribeRequestDto("", 0));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // Its own host, not the shared one: a sibling test in this class connects for real, and
    // "not connected" is only true here if nothing else has touched the same connection manager.
    [Fact]
    public async Task Subscribe_without_connection_returns_409()
    {
        using var factory = new MqttForgeApiFactory();
        var client = factory.CreateClient();

        var response = await client.PostAsJsonAsync("/api/subscriptions", new SubscribeRequestDto("sensors/#", 0));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
    }

    // End to end: subscribe -> an external publisher sends -> it reaches the console over SignalR
    [Fact]
    public async Task Incoming_message_reaches_a_SignalR_client()
    {
        var client = _factory.CreateClient();

        await using var hub = new HubConnectionBuilder()
            .WithUrl(new Uri(_factory.Server.BaseAddress, "hubs/mqtt"),
                o => o.HttpMessageHandlerFactory = _ => _factory.Server.CreateHandler())
            .Build();

        var received = new TaskCompletionSource<IncomingMessage>();
        hub.On<IncomingMessage[]>("messagesReceived", batch => received.TrySetResult(batch[0]));
        await hub.StartAsync();

        var connect = new ConnectRequestDto(_broker.Host, _broker.Port, "signalr-e2e", null, null, false);
        (await client.PostAsJsonAsync("/api/connection", connect)).EnsureSuccessStatusCode();

        var subscribe = await client.PostAsJsonAsync("/api/subscriptions", new SubscribeRequestDto("lab/#", 0));
        Assert.Equal(HttpStatusCode.Accepted, subscribe.StatusCode);

        var active = await client.GetFromJsonAsync<string[]>("/api/subscriptions");
        Assert.Contains("lab/#", active!);

        using var external = new MqttClientFactory().CreateMqttClient();
        await external.ConnectAsync(new MqttClientOptionsBuilder()
            .WithTcpServer(_broker.Host, _broker.Port).Build());
        await external.PublishStringAsync("lab/oven/temp", "180");

        var message = await received.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal("lab/oven/temp", message.Topic);
        Assert.Equal("180", message.Payload);
    }

    private sealed record IncomingMessage(string Topic, string Payload, int Qos, bool Retain);
}
