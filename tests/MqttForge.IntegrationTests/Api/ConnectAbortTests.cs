using System.Net;
using System.Net.Http.Json;
using MqttForge.Api.Contracts;
using MqttForge.IntegrationTests.Support;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

// A connect attempt outlives the panel that started it, so calling it off has to be a request
// of its own rather than something the original caller hangs up on.
public class ConnectAbortTests : IClassFixture<MqttForgeApiFactory>
{
    private readonly MqttForgeApiFactory _factory;

    public ConnectAbortTests(MqttForgeApiFactory factory) => _factory = factory;

    [Fact]
    public async Task Aborting_an_attempt_answers_the_connect_with_409_aborted()
    {
        using var silent = new SilentTcpListener();
        var client = _factory.CreateClient();

        var connecting = Connect(client, silent.Port);
        await WaitUntilConnecting(client);
        var abort = await client.DeleteAsync("/api/connection/attempt");

        Assert.Equal(HttpStatusCode.NoContent, abort.StatusCode);
        var response = await connecting;
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<ProblemDetailsResponse>();
        Assert.Equal("aborted", problem!.Reason);
    }

    // Nobody's fault but the user's, so the console has nothing to explain afterwards.
    [Fact]
    public async Task An_aborted_attempt_leaves_the_connection_disconnected_not_faulted()
    {
        using var silent = new SilentTcpListener();
        var client = _factory.CreateClient();

        var connecting = Connect(client, silent.Port);
        await WaitUntilConnecting(client);
        await client.DeleteAsync("/api/connection/attempt");
        await connecting;

        var body = await client.GetStringAsync("/api/connection");
        Assert.Contains("\"state\":\"Disconnected\"", body);
        Assert.Contains("\"failure\":null", body);
    }

    // Whoever asked wanted the attempt stopped, and it already is.
    [Fact]
    public async Task Aborting_with_nothing_in_flight_is_not_an_error()
    {
        var client = _factory.CreateClient();

        var response = await client.DeleteAsync("/api/connection/attempt");

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
    }

    private static Task<HttpResponseMessage> Connect(HttpClient client, int port) =>
        client.PostAsJsonAsync(
            "/api/connection", new ConnectRequestDto("127.0.0.1", port, "probe", null, null, false));

    // The POST is still open, so the state query is the only way to know the attempt has started.
    private static async Task WaitUntilConnecting(HttpClient client)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (!(await client.GetStringAsync("/api/connection")).Contains("\"state\":\"Connecting\""))
            await Task.Delay(20, deadline.Token);
    }

    private sealed record ProblemDetailsResponse(string Title, string Detail, int Status, string Reason);
}
