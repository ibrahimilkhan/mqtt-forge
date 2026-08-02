using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using MQFaker.IntegrationTests.Support;

namespace MQFaker.IntegrationTests.Api;

public sealed class HostConfigurationTests
{
    // No launchSettings.json in the published app; without Urls config, Kestrel falls back
    // to 5000 (macOS AirPlay's port)
    [Fact]
    public void Urls_are_pinned_so_the_published_app_does_not_fall_back_to_port_5000()
    {
        using var factory = new MqFakerApiFactory();

        var configuration = factory.Services.GetRequiredService<IConfiguration>();

        Assert.Equal("http://0.0.0.0:5169", configuration["Urls"]);
    }
}
