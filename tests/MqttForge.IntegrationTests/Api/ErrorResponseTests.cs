using System.Net;
using System.Net.Http.Json;
using MqttForge.Api.Contracts;
using MqttForge.IntegrationTests.Support;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

// Failures come back as readable ProblemDetails
public class ErrorResponseTests : IClassFixture<MqttForgeApiFactory>
{
    private readonly MqttForgeApiFactory _factory;

    public ErrorResponseTests(MqttForgeApiFactory factory) => _factory = factory;

    [Fact]
    public async Task Publish_without_connection_returns_409_with_readable_detail()
    {
        var client = _factory.CreateClient();
        var dto = new PublishRequestDto("sensors/temp", "23.5", null, 0, false);

        var response = await client.PostAsJsonAsync("/api/publish", dto);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<ProblemDetailsResponse>();
        Assert.Equal("Not connected", problem!.Title);
        Assert.Contains("Connect to a broker", problem.Detail, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Connect_to_unreachable_broker_returns_502_with_readable_detail()
    {
        var client = _factory.CreateClient();
        // A port expected to be closed, so the connection is refused
        var dto = new ConnectRequestDto("127.0.0.1", 1, "probe", null, null, false);

        var response = await client.PostAsJsonAsync("/api/connection", dto);

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<ProblemDetailsResponse>();
        Assert.Equal("Could not connect to broker", problem!.Title);
        Assert.Contains("127.0.0.1:1", problem.Detail);
        // The console words the sentence; this code is what tells it which sentence to word
        Assert.Equal("refused", problem.Reason);
    }

    // The 502 is gone by the time a panel reopens; the state query is what's left to ask.
    [Fact]
    public async Task Connection_state_keeps_reporting_why_the_last_attempt_failed()
    {
        var client = _factory.CreateClient();
        await client.PostAsJsonAsync("/api/connection", new ConnectRequestDto("127.0.0.1", 1, "probe", null, null, false));

        var response = await client.GetAsync("/api/connection");

        var body = await response.Content.ReadAsStringAsync();
        Assert.Contains("\"state\":\"Faulted\"", body);
        Assert.Contains("\"reason\":\"refused\"", body);
        // The saved settings only record a SUCCESSFUL connect, so the console cannot work out
        // which broker this was about unless the state says so.
        Assert.Contains("\"host\":\"127.0.0.1\"", body);
        Assert.Contains("\"port\":1", body);
    }

    private sealed record ProblemDetailsResponse(string Title, string Detail, int Status, string Reason);
}
