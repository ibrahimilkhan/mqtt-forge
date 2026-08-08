using System.Net.Http.Json;
using System.Text.Json;
using MQFaker.Api.Contracts;
using MQFaker.IntegrationTests.Support;
using Xunit;

namespace MQFaker.IntegrationTests.Api;

// The state endpoint says which broker is up, not just that one is.
public class ConnectionDetailsTests : IClassFixture<MqFakerApiFactory>, IClassFixture<MosquittoFixture>
{
    private readonly MqFakerApiFactory _factory;
    private readonly MosquittoFixture _broker;

    public ConnectionDetailsTests(MqFakerApiFactory factory, MosquittoFixture broker)
    {
        _factory = factory;
        _broker = broker;
    }

    [Fact]
    public async Task Connection_state_carries_the_live_link()
    {
        var client = _factory.CreateClient();
        var connect = new ConnectRequestDto(
            _broker.Host, _broker.Port, "details-test", "gizli-kullanici", "gizli-sifre", false);
        (await client.PostAsJsonAsync("/api/connection", connect)).EnsureSuccessStatusCode();

        var response = await client.GetAsync("/api/connection");
        response.EnsureSuccessStatusCode();

        var raw = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain("gizli-sifre", raw);

        var link = JsonDocument.Parse(raw).RootElement.GetProperty("connection");
        Assert.Equal(_broker.Host, link.GetProperty("host").GetString());
        Assert.Equal(_broker.Port, link.GetProperty("port").GetInt32());
        Assert.Equal("details-test", link.GetProperty("clientId").GetString());
        Assert.Equal("gizli-kullanici", link.GetProperty("username").GetString());
        Assert.False(link.GetProperty("useTls").GetBoolean());
        Assert.False(link.GetProperty("sessionPresent").GetBoolean());
        Assert.True(link.GetProperty("connectedAt").GetDateTimeOffset() > DateTimeOffset.MinValue);
    }

    [Fact]
    public async Task Connection_state_carries_no_link_once_disconnected()
    {
        var client = _factory.CreateClient();
        var connect = new ConnectRequestDto(_broker.Host, _broker.Port, "details-gone", null, null, false);
        (await client.PostAsJsonAsync("/api/connection", connect)).EnsureSuccessStatusCode();
        (await client.DeleteAsync("/api/connection")).EnsureSuccessStatusCode();

        var response = await client.GetAsync("/api/connection");

        var raw = await response.Content.ReadAsStringAsync();
        var link = JsonDocument.Parse(raw).RootElement.GetProperty("connection");
        Assert.Equal(JsonValueKind.Null, link.ValueKind);
    }
}
