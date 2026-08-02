using System.Net;
using System.Net.Http.Json;
using MQFaker.Api.Contracts;
using MQFaker.IntegrationTests.Support;
using Xunit;

namespace MQFaker.IntegrationTests.Api;

// Verifies saved settings are readable again and that the password never leaks out
public class SavedSettingsTests : IClassFixture<MqFakerApiFactory>, IClassFixture<MosquittoFixture>
{
    private readonly MqFakerApiFactory _factory;
    private readonly MosquittoFixture _broker;

    public SavedSettingsTests(MqFakerApiFactory factory, MosquittoFixture broker)
    {
        _factory = factory;
        _broker = broker;
    }

    [Fact]
    public async Task Saved_settings_are_returned_without_the_password()
    {
        var client = _factory.CreateClient();
        var connect = new ConnectRequestDto(
            _broker.Host, _broker.Port, "saved-test", "gizli-kullanici", "gizli-sifre", false);

        var connectResponse = await client.PostAsJsonAsync("/api/connection", connect);
        connectResponse.EnsureSuccessStatusCode();

        var response = await client.GetAsync("/api/connection/settings");
        response.EnsureSuccessStatusCode();

        var raw = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain("gizli-sifre", raw);

        var saved = await response.Content.ReadFromJsonAsync<SavedConnectionDto>();
        Assert.Equal(_broker.Host, saved!.Host);
        Assert.Equal("gizli-kullanici", saved.Username);
        Assert.True(saved.HasPassword);
    }

    [Fact]
    public async Task Connecting_twice_with_identical_settings_is_a_no_op()
    {
        var client = _factory.CreateClient();
        var connect = new ConnectRequestDto(_broker.Host, _broker.Port, "twice-test", null, null, false);

        var first = await client.PostAsJsonAsync("/api/connection", connect);
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Contains("\"alreadyConnected\":false", await first.Content.ReadAsStringAsync());

        var second = await client.PostAsJsonAsync("/api/connection", connect);
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        Assert.Contains("\"alreadyConnected\":true", await second.Content.ReadAsStringAsync());

        var state = await client.GetAsync("/api/connection");
        Assert.Contains("Connected", await state.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Connecting_twice_with_different_settings_reconnects()
    {
        var client = _factory.CreateClient();
        var first = new ConnectRequestDto(_broker.Host, _broker.Port, "differ-test-1", null, null, false);
        var second = new ConnectRequestDto(_broker.Host, _broker.Port, "differ-test-2", null, null, false);

        var firstResponse = await client.PostAsJsonAsync("/api/connection", first);
        Assert.Contains("\"alreadyConnected\":false", await firstResponse.Content.ReadAsStringAsync());

        var secondResponse = await client.PostAsJsonAsync("/api/connection", second);
        Assert.Equal(HttpStatusCode.OK, secondResponse.StatusCode);
        Assert.Contains("\"alreadyConnected\":false", await secondResponse.Content.ReadAsStringAsync());
    }
}
