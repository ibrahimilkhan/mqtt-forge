using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.DependencyInjection;
using MqttForge.Api.Contracts;
using MqttForge.Application.Services;
using MqttForge.Domain.Models;
using MqttForge.IntegrationTests.Support;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

// The brokers this console reached, across the boundary and back.
//
// Nothing here is added by a request — the only way in is a connection a broker accepted — so the
// tests that need a row put one in through the service the connection uses, and read it back over
// HTTP. That is the seam worth testing here: a broker of our own would test MQTTnet.
//
// A fresh factory per test, like the saved brokers beside it: every test writes the same stored
// list and xUnit gives no order within a class.
public class RecentBrokerEndpointTests : IDisposable
{
    private readonly MqttForgeApiFactory _factory = new();

    public void Dispose() => _factory.Dispose();

    private static readonly JsonSerializerOptions AsSent = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
    };

    private async Task<RecentBrokerDto[]> RecentOf(HttpClient client) =>
        await client.GetFromJsonAsync<RecentBrokerDto[]>("/api/connection/recent", AsSent) ?? [];

    private Task Reached(BrokerConnectionSettings settings) =>
        _factory.Services.GetRequiredService<RecentBrokerService>()
            .RecordAsync(settings, CancellationToken.None);

    private static BrokerConnectionSettings Settings(
        string host = "broker.example", int port = 1883, string? password = null) =>
        new(host, port, "console", "alice", password, UseTls: false);

    [Fact]
    public async Task The_history_starts_empty()
    {
        var client = _factory.CreateClient();

        Assert.Empty(await RecentOf(client));
    }

    [Fact]
    public async Task A_broker_that_was_reached_comes_back_newest_first()
    {
        var client = _factory.CreateClient();

        await Reached(Settings("one.example"));
        await Reached(Settings("two.example", 8883));

        var brokers = await RecentOf(client);

        Assert.Equal(["two.example", "one.example"], brokers.Select(one => one.Connection.Host));
        Assert.Equal(8883, brokers[0].Connection.Port);
        Assert.Equal("alice", brokers[0].Connection.Username);
    }

    // The same rule as the saved brokers: what the console is told is whether there is a
    // password, never what it is.
    [Fact]
    public async Task The_password_never_comes_back()
    {
        var client = _factory.CreateClient();

        await Reached(Settings(password: "hunter2"));

        var raw = await client.GetStringAsync("/api/connection/recent");

        Assert.DoesNotContain("hunter2", raw);

        // And not even as 'there is one'. Nothing kept a password to have an opinion about.
        Assert.False((await RecentOf(client))[0].Connection.HasPassword);
    }

    [Fact]
    public async Task A_row_can_be_forgotten_by_its_id()
    {
        var client = _factory.CreateClient();
        await Reached(Settings());

        var id = (await RecentOf(client))[0].Id;
        var gone = await client.DeleteAsync($"/api/connection/recent/{id}");

        Assert.Equal(HttpStatusCode.NoContent, gone.StatusCode);
        Assert.Empty(await RecentOf(client));
    }

    [Fact]
    public async Task Forgetting_something_that_is_not_there_is_a_404()
    {
        var client = _factory.CreateClient();

        var gone = await client.DeleteAsync("/api/connection/recent/0123456789abcdef");

        Assert.Equal(HttpStatusCode.NotFound, gone.StatusCode);
    }
}
