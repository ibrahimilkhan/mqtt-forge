using System.Net;
using MqttForge.IntegrationTests.Support;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

// The API process being up, independent of any broker connection
public sealed class HealthEndpointTests : IClassFixture<MqttForgeApiFactory>
{
    private readonly MqttForgeApiFactory _factory;

    public HealthEndpointTests(MqttForgeApiFactory factory) => _factory = factory;

    [Fact]
    public async Task Health_reports_ok_without_needing_a_broker()
    {
        var client = _factory.CreateClient();

        var response = await client.GetAsync("/api/health");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("\"status\":\"ok\"", await response.Content.ReadAsStringAsync());
    }
}
