using System.Net;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using MqttForge.IntegrationTests.Support;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

/// <summary>
/// The guard in the pipeline, rather than the rule on its own.
///
/// A page the reader is shown from <c>http://evil.example:5169</c> keeps that as its origin, and
/// the attacker then re-resolves the name to <c>127.0.0.1</c>. The fetch that follows is
/// same-origin as far as the browser is concerned, so nothing about CORS stands in its way, and it
/// reaches a server bound to loopback alone. The <c>Host</c> header is the only part of the
/// request that still says which name was asked for.
/// </summary>
public sealed class HostGuardEndpointTests : IClassFixture<MqttForgeApiFactory>
{
    private readonly MqttForgeApiFactory _factory;

    public HostGuardEndpointTests(MqttForgeApiFactory factory) => _factory = factory;

    [Theory]
    [InlineData("localhost")]
    [InlineData("127.0.0.1:5169")]
    [InlineData("192.168.1.24:5169")]
    [InlineData("[::1]:5169")]
    [InlineData("kitchen-pi.local:5169")]
    public async Task Answers_the_ways_this_app_is_actually_reached(string host)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Host = host;

        var response = await client.GetAsync("/api/health");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Theory]
    [InlineData("/api/health")]
    [InlineData("/api/connection")]
    // The static site too: the page is what would have to be served for the rest to be asked for.
    [InlineData("/")]
    public async Task Refuses_a_rebound_name(string path)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Host = "evil.example:5169";

        var response = await client.GetAsync(path);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // Nothing is leaked on the way to the refusal: the saved settings name the broker and the
    // username, which is the read half of what rebinding is worth doing for.
    [Fact]
    public async Task Says_nothing_about_the_broker_to_a_rebound_name()
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Host = "evil.example:5169";

        var response = await client.GetAsync("/api/connection/settings");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(string.Empty, await response.Content.ReadAsStringAsync());
    }

    // An operator who wants a name of their own says so, and takes the question over: from there
    // ASP.NET's own host filtering is what decides, which is the mechanism .NET users already know.
    [Fact]
    public async Task Stands_down_where_AllowedHosts_names_the_hosts()
    {
        using var named = new NamedHostFactory(_factory, "mqtt.example.com");
        var client = named.CreateClient();
        client.DefaultRequestHeaders.Host = "mqtt.example.com";

        var response = await client.GetAsync("/api/health");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    // And having taken it over, it is theirs: a name outside the list is refused by ASP.NET.
    [Fact]
    public async Task Leaves_an_unnamed_host_to_AspNets_own_filtering()
    {
        using var named = new NamedHostFactory(_factory, "mqtt.example.com");
        var client = named.CreateClient();
        client.DefaultRequestHeaders.Host = "evil.example";

        var response = await client.GetAsync("/api/health");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    /// <summary>
    /// The same app with AllowedHosts set, which is how the guard is stood down. Built here rather
    /// than through MqttForgeApiFactory, which is sealed and takes no extra configuration; it
    /// lends its paths so this host remembers the same nothing.
    /// </summary>
    private sealed class NamedHostFactory : WebApplicationFactory<Program>
    {
        private readonly MqttForgeApiFactory _from;
        private readonly string _allowed;

        public NamedHostFactory(MqttForgeApiFactory from, string allowed)
        {
            _from = from;
            _allowed = allowed;
        }

        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.ConfigureAppConfiguration((_, config) =>
                config.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["MqttForge:SettingsPath"] = _from.SettingsPath,
                    ["MqttForge:ColourRulesPath"] = _from.ColourRulesPath,
                    ["AllowedHosts"] = _allowed
                }));
        }
    }
}
