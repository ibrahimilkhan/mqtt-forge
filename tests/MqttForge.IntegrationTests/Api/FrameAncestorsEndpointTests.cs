using System.Net;
using System.Text;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using MqttForge.Api;
using MqttForge.IntegrationTests.Support;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

/// <summary>
/// Who may show the console in a frame, said on every answer.
///
/// A page on another site that frames the console can lay a decoy over Disconnect, Inject, Delete
/// flow or Clear history, and the reader's click lands on the console itself, whose requests from
/// inside the frame are its own page's and pass the origin guard. Nothing said who could frame it.
/// </summary>
public sealed class FrameAncestorsEndpointTests : IClassFixture<MqttForgeApiFactory>
{
    private readonly MqttForgeApiFactory _factory;

    public FrameAncestorsEndpointTests(MqttForgeApiFactory factory) => _factory = factory;

    // The page, the API, a route that is not there, and the refusals of both guards: whatever the
    // answer, and whoever wrote it.
    [Theory]
    [InlineData("GET", "/", null, null)]
    [InlineData("GET", "/api/health", null, null)]
    [InlineData("GET", "/api/nothing-here", null, null)]
    [InlineData("POST", "/api/flows/x/nodes/x/inject", "http://evil.example", null)]
    [InlineData("GET", "/api/health", null, "evil.example:5169")]
    public async Task Every_answer_says_only_the_consoles_own_page_may_frame_it(string method, string path, string? origin, string? host)
    {
        var request = new HttpRequestMessage(new HttpMethod(method), path);
        if (origin is not null) request.Headers.Add("Origin", origin);
        if (host is not null) request.Headers.Host = host;
        if (method == "POST") request.Content = new StringContent("", Encoding.UTF8, "text/plain");

        var response = await _factory.CreateClient().SendAsync(request);

        Assert.Equal(["frame-ancestors 'self'"], response.Headers.GetValues("Content-Security-Policy"));
        Assert.Equal(["SAMEORIGIN"], response.Headers.GetValues("X-Frame-Options"));
    }

    // Someone showing the console in a Home Assistant panel names the panel's page, and it is let in
    // beside the console's own.
    [Fact]
    public async Task A_page_named_in_the_setting_may_frame_it_too()
    {
        using var factory = new MqttForgeApiFactory();
        using var named = factory.WithWebHostBuilder(b => b.ConfigureAppConfiguration((_, config) =>
            config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                [FrameAncestors.Setting] = "http://homeassistant.local:8123",
            })));

        var response = await named.CreateClient().GetAsync("/");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(["frame-ancestors 'self' http://homeassistant.local:8123"], response.Headers.GetValues("Content-Security-Policy"));
        Assert.Equal(["SAMEORIGIN"], response.Headers.GetValues("X-Frame-Options"));
    }

    // A setting that would put something else in the policy does not start the app, rather than
    // starting one that sends it.
    [Fact]
    public void A_setting_that_is_no_page_stops_the_app_starting()
    {
        using var factory = new MqttForgeApiFactory();
        using var broken = factory.WithWebHostBuilder(b => b.ConfigureAppConfiguration((_, config) =>
            config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                [FrameAncestors.Setting] = "https://ha.example.com; script-src *",
            })));

        var refused = Assert.ThrowsAny<Exception>(() => broken.CreateClient());

        Assert.Contains(FrameAncestors.Setting, refused.ToString());
    }
}
