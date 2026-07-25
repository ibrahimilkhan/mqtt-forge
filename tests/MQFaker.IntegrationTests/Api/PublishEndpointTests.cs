using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using MQFaker.Api.Contracts;
using Xunit;

namespace MQFaker.IntegrationTests.Api;

public class PublishEndpointTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;

    public PublishEndpointTests(WebApplicationFactory<Program> factory) => _factory = factory;

    [Fact]
    public async Task Publish_with_empty_topic_returns_400()
    {
        var client = _factory.CreateClient();
        var dto = new PublishRequestDto(Topic: "", Payload: "x", Qos: 0, Retain: false);

        var response = await client.PostAsJsonAsync("/api/publish", dto);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Publish_with_out_of_range_qos_returns_400()
    {
        var client = _factory.CreateClient();
        var dto = new PublishRequestDto(Topic: "sensors/temp", Payload: "x", Qos: 5, Retain: false);

        var response = await client.PostAsJsonAsync("/api/publish", dto);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task GetConnectionState_returns_disconnected_initially()
    {
        var client = _factory.CreateClient();

        var response = await client.GetAsync("/api/connection");

        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadAsStringAsync();
        Assert.Contains("Disconnected", body);
    }

    [Fact]
    public async Task Connect_with_invalid_port_returns_400()
    {
        var client = _factory.CreateClient();
        var dto = new ConnectRequestDto("localhost", 0, "client", null, null, false);

        var response = await client.PostAsJsonAsync("/api/connection", dto);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
