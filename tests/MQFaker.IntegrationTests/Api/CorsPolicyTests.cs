using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using MQFaker.IntegrationTests.Support;

namespace MQFaker.IntegrationTests.Api;

public sealed class CorsPolicyTests
{
    // In both shipped packages the interface is served by the API itself, so a
    // cross-origin allowance for the Vite dev server is dead configuration there.
    [Fact]
    public async Task Production_does_not_answer_with_a_cross_origin_allowance()
    {
        using var factory = new MqFakerApiFactory();
        using var client = factory.WithWebHostBuilder(b => b.UseEnvironment("Production")).CreateClient();

        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/connection");
        request.Headers.Add("Origin", "http://localhost:5173");

        var response = await client.SendAsync(request);

        Assert.False(response.Headers.Contains("Access-Control-Allow-Origin"));
    }

    [Fact]
    public async Task Development_still_allows_the_vite_dev_server()
    {
        using var factory = new MqFakerApiFactory();
        using var client = factory.WithWebHostBuilder(b => b.UseEnvironment("Development")).CreateClient();

        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/connection");
        request.Headers.Add("Origin", "http://localhost:5173");

        var response = await client.SendAsync(request);

        Assert.Contains("http://localhost:5173", response.Headers.GetValues("Access-Control-Allow-Origin"));
    }
}
