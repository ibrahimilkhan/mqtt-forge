using System.Net;
using System.Net.Http.Json;
using MqttForge.Api.Contracts;
using MqttForge.IntegrationTests.Support;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

public class PublishEndpointTests : IClassFixture<MqttForgeApiFactory>
{
    private readonly MqttForgeApiFactory _factory;

    public PublishEndpointTests(MqttForgeApiFactory factory) => _factory = factory;

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
    public async Task GetSavedSettings_returns_204_when_nothing_saved()
    {
        var client = _factory.CreateClient();

        var response = await client.GetAsync("/api/connection/settings");

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
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
