using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using MqttForge.Api.Contracts;
using MqttForge.Domain.Enums;
using MqttForge.IntegrationTests.Support;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

// Brokers somebody chose to keep, across the boundary and back.
//
// A fresh factory per test rather than a shared fixture: every test here writes the same stored
// list, and xUnit gives no order within a class — a shared file would make "starts empty" depend
// on which test ran first. No broker is involved, so a host per test is cheap.
public class SavedProfileEndpointTests : IDisposable
{
    private readonly MqttForgeApiFactory _factory = new();

    public void Dispose() => _factory.Dispose();

    // The API writes enums as names; a plain HttpClient reader does not know that on the way
    // back in. The console's own fetch has the same job and the same answer.
    private static readonly JsonSerializerOptions AsSent = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
    };

    private async Task<SavedProfileDto[]> ProfilesOf(HttpClient client) =>
        await client.GetFromJsonAsync<SavedProfileDto[]>("/api/connection/profiles", AsSent) ?? [];

    private static SaveProfileRequestDto Profile(
        string name, string host = "broker.example", int port = 1883, string? password = null) =>
        new(name, new ConnectRequestDto(host, port, "console", "alice", password, UseTls: false));

    [Fact]
    public async Task Profiles_start_empty()
    {
        var client = _factory.CreateClient();

        Assert.Empty(await ProfilesOf(client));
    }

    [Fact]
    public async Task A_saved_profile_is_read_back_under_its_name()
    {
        var client = _factory.CreateClient();

        var put = await client.PutAsJsonAsync("/api/connection/profiles", Profile("Lab broker"));
        Assert.Equal(HttpStatusCode.NoContent, put.StatusCode);

        var one = Assert.Single(await ProfilesOf(client));

        Assert.Equal("Lab broker", one.Name);
        Assert.Equal("broker.example", one.Connection.Host);
        Assert.Equal("alice", one.Connection.Username);
    }

    // The whole shape, not just the address: a profile that lost its transport would reconnect
    // somewhere other than where it was saved.
    [Fact]
    public async Task A_profile_keeps_the_way_in_it_was_saved_with()
    {
        var client = _factory.CreateClient();
        var sent = new SaveProfileRequestDto("Cloud", new ConnectRequestDto(
            "abc.example", 8084, "console", null, null, UseTls: true,
            Transport: MqttTransport.WebSocket,
            ProtocolVersion: MqttProtocolLevel.V500,
            WebSocketPath: "/mqtt",
            Tls: new TlsOptionsDto(AlpnProtocol: "x-amzn-mqtt-ca")));

        await client.PutAsJsonAsync("/api/connection/profiles", sent);

        var one = Assert.Single(await ProfilesOf(client));

        Assert.Equal(MqttTransport.WebSocket, one.Connection.Transport);
        Assert.True(one.Connection.UseTls);
        Assert.Equal("/mqtt", one.Connection.WebSocketPath);
        Assert.Equal("x-amzn-mqtt-ca", one.Connection.Tls!.AlpnProtocol);
    }

    // The same rule the saved settings keep, for the same reason: a password on the wire back is
    // a password in a browser's cache and in anything that logs a response.
    [Fact]
    public async Task A_password_is_kept_but_never_sent_back()
    {
        var client = _factory.CreateClient();

        await client.PutAsJsonAsync("/api/connection/profiles", Profile("Lab broker", password: "hunter2"));

        var one = Assert.Single(await ProfilesOf(client));

        Assert.True(one.Connection.HasPassword);
        var raw = await client.GetStringAsync("/api/connection/profiles");
        Assert.DoesNotContain("hunter2", raw);
    }

    [Fact]
    public async Task Saving_a_name_that_is_here_replaces_it()
    {
        var client = _factory.CreateClient();
        await client.PutAsJsonAsync("/api/connection/profiles", Profile("Lab broker", port: 1883));

        await client.PutAsJsonAsync("/api/connection/profiles", Profile("Lab broker", port: 21883));

        var one = Assert.Single(await ProfilesOf(client));
        Assert.Equal(21883, one.Connection.Port);
    }

    [Fact]
    public async Task Deleting_removes_it()
    {
        var client = _factory.CreateClient();
        await client.PutAsJsonAsync("/api/connection/profiles", Profile("Lab broker"));

        var gone = await client.DeleteAsync("/api/connection/profiles/Lab%20broker");

        Assert.Equal(HttpStatusCode.NoContent, gone.StatusCode);
        Assert.Empty(await ProfilesOf(client));
    }

    [Fact]
    public async Task Deleting_one_that_was_never_saved_is_a_404()
    {
        var client = _factory.CreateClient();

        var gone = await client.DeleteAsync("/api/connection/profiles/never-saved");

        Assert.Equal(HttpStatusCode.NotFound, gone.StatusCode);
    }

    // A chip with no word on it is a chip nobody can press deliberately.
    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task A_nameless_profile_is_refused(string name)
    {
        var client = _factory.CreateClient();

        var put = await client.PutAsJsonAsync("/api/connection/profiles", Profile(name));

        Assert.Equal(HttpStatusCode.BadRequest, put.StatusCode);
    }

    [Fact]
    public async Task A_name_longer_than_a_chip_can_carry_is_refused()
    {
        var client = _factory.CreateClient();

        var put = await client.PutAsJsonAsync("/api/connection/profiles", Profile(new string('x', 61)));

        Assert.Equal(HttpStatusCode.BadRequest, put.StatusCode);
    }
}
