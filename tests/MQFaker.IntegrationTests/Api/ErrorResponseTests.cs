using System.Net;
using System.Net.Http.Json;
using MQFaker.Api.Contracts;
using MQFaker.IntegrationTests.Support;
using Xunit;

namespace MQFaker.IntegrationTests.Api;

// Failures come back as readable ProblemDetails
public class ErrorResponseTests : IClassFixture<MqFakerApiFactory>
{
    private readonly MqFakerApiFactory _factory;

    public ErrorResponseTests(MqFakerApiFactory factory) => _factory = factory;

    [Fact]
    public async Task Publish_without_connection_returns_409_with_readable_detail()
    {
        var client = _factory.CreateClient();
        var dto = new PublishRequestDto("sensors/temp", "23.5", 0, false);

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

    private sealed record ProblemDetailsResponse(string Title, string Detail, int Status, string Reason);
}
