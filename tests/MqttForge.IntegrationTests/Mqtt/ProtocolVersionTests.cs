using System.Net;
using System.Net.Http.Json;
using MqttForge.Api.Contracts;
using MqttForge.Domain.Enums;
using MqttForge.IntegrationTests.Support;
using Xunit;

namespace MqttForge.IntegrationTests.Mqtt;

// Every MQTT version, against a broker that speaks all three.
public class ProtocolVersionTests : IClassFixture<MqttForgeApiFactory>, IClassFixture<MosquittoFixture>
{
    private readonly MqttForgeApiFactory _factory;
    private readonly MosquittoFixture _broker;

    public ProtocolVersionTests(MqttForgeApiFactory factory, MosquittoFixture broker)
    {
        _factory = factory;
        _broker = broker;
    }

    [Theory]
    [InlineData(MqttProtocolLevel.V500)]
    [InlineData(MqttProtocolLevel.V311)]
    [InlineData(MqttProtocolLevel.V310)]
    public async Task A_version_asked_for_by_name_is_the_version_that_connects(MqttProtocolLevel version)
    {
        var client = _factory.CreateClient();
        var dto = Request($"version-{version}") with { ProtocolVersion = version };

        var response = await client.PostAsJsonAsync("/api/connection", dto);

        response.EnsureSuccessStatusCode();
        Assert.Equal(version, await ConnectedVersion(client));
    }

    // Auto is not a version, and the link never reports it: what comes back is what was agreed.
    [Fact]
    public async Task Auto_reports_the_version_it_settled_on_rather_than_the_word_auto()
    {
        var client = _factory.CreateClient();

        var response = await client.PostAsJsonAsync("/api/connection", Request("version-auto"));

        response.EnsureSuccessStatusCode();
        Assert.Equal(MqttProtocolLevel.V500, await ConnectedVersion(client));
    }

    private ConnectRequestDto Request(string clientId) =>
        new(_broker.Host, _broker.Port, clientId, null, null, false);

    private static async Task<MqttProtocolLevel> ConnectedVersion(HttpClient client)
    {
        var state = await client.GetFromJsonAsync<StateResponse>("/api/connection", WireJson.Client);

        return state!.Connection!.ProtocolVersion;
    }

    private sealed record StateResponse(string State, BrokerLinkDto? Connection);
}

// The version ladder, against the one broker in the suite that makes it do anything.
public class VersionLadderTests : IClassFixture<MqttForgeApiFactory>, IClassFixture<LegacyMosquittoFixture>
{
    private readonly MqttForgeApiFactory _factory;
    private readonly LegacyMosquittoFixture _broker;

    public VersionLadderTests(MqttForgeApiFactory factory, LegacyMosquittoFixture broker)
    {
        _factory = factory;
        _broker = broker;
    }

    // The whole point of Auto: a broker from before MQTT 5 connects anyway, and says what it is.
    [Fact]
    public async Task Auto_steps_down_to_a_version_a_pre_5_broker_speaks()
    {
        var client = _factory.CreateClient();

        var response = await client.PostAsJsonAsync("/api/connection", Request("ladder-auto"));

        response.EnsureSuccessStatusCode();
        var state = await client.GetFromJsonAsync<StateResponse>("/api/connection", WireJson.Client);
        Assert.Equal(MqttProtocolLevel.V311, state!.Connection!.ProtocolVersion);
    }

    // Asked for by name, the same broker refuses — and the console says which version it was
    // about, because this time somebody chose it.
    [Fact]
    public async Task A_version_the_broker_does_not_speak_is_refused_by_name()
    {
        var client = _factory.CreateClient();
        var dto = Request("ladder-pinned") with { ProtocolVersion = MqttProtocolLevel.V500 };

        var response = await client.PostAsJsonAsync("/api/connection", dto);

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        Assert.Contains(
            "\"reason\":\"protocolVersionUnsupported\"", await response.Content.ReadAsStringAsync());
    }

    // Both of the older ones are reachable on this broker, so the ladder is stepping rather than
    // falling all the way to the bottom.
    [Fact]
    public async Task The_oldest_version_still_connects_when_it_is_the_one_asked_for()
    {
        var client = _factory.CreateClient();
        var dto = Request("ladder-310") with { ProtocolVersion = MqttProtocolLevel.V310 };

        var response = await client.PostAsJsonAsync("/api/connection", dto);

        response.EnsureSuccessStatusCode();
        var state = await client.GetFromJsonAsync<StateResponse>("/api/connection", WireJson.Client);
        Assert.Equal(MqttProtocolLevel.V310, state!.Connection!.ProtocolVersion);
    }

    private ConnectRequestDto Request(string clientId) =>
        new(_broker.Host, _broker.Port, clientId, null, null, false);

    private sealed record StateResponse(string State, BrokerLinkDto? Connection);
}
