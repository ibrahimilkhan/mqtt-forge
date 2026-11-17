using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using MqttForge.Api.Contracts;
using MqttForge.Domain.Abstractions;
using MqttForge.IntegrationTests.Support;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

// The state endpoint says which broker is up, not just that one is.
public class ConnectionDetailsTests : IClassFixture<MqttForgeApiFactory>, IClassFixture<MosquittoFixture>
{
    private readonly MqttForgeApiFactory _factory;
    private readonly MosquittoFixture _broker;

    public ConnectionDetailsTests(MqttForgeApiFactory factory, MosquittoFixture broker)
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

    // Which saved broker the link was made from decides which colour and alert rules apply to it,
    // so the link says so — and the settings a redial and a start-up connect are made from keep it,
    // so a link the supervisor brings back is still that broker.
    [Fact]
    public async Task A_link_made_from_a_saved_broker_names_it_and_the_settings_keep_it()
    {
        var client = _factory.CreateClient();
        var connect = new ConnectRequestDto(
            _broker.Host, _broker.Port, "details-profile", null, null, false, ProfileId: "lab-1");
        (await client.PostAsJsonAsync("/api/connection", connect)).EnsureSuccessStatusCode();

        var raw = await client.GetStringAsync("/api/connection");
        var link = JsonDocument.Parse(raw).RootElement.GetProperty("connection");
        Assert.Equal("lab-1", link.GetProperty("profileId").GetString());

        var saved = await _factory.Services.GetRequiredService<IConnectionSettingsStore>()
            .LoadAsync(CancellationToken.None);
        Assert.Equal("lab-1", saved!.ProfileId);
    }

    [Fact]
    public async Task A_link_typed_in_names_no_saved_broker()
    {
        var client = _factory.CreateClient();
        var connect = new ConnectRequestDto(_broker.Host, _broker.Port, "details-typed", null, null, false);
        (await client.PostAsJsonAsync("/api/connection", connect)).EnsureSuccessStatusCode();

        var raw = await client.GetStringAsync("/api/connection");
        var link = JsonDocument.Parse(raw).RootElement.GetProperty("connection");
        Assert.Equal(JsonValueKind.Null, link.GetProperty("profileId").ValueKind);
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
