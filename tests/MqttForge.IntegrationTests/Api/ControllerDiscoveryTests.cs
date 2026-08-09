using System.Net;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using MqttForge.Api;

namespace MqttForge.IntegrationTests.Api;

// WebApplicationFactory pins ApplicationName to MqttForge.Api, masking a deleted AddApplicationPart;
// this builds under a different entry assembly instead, like the desktop shell
public sealed class ControllerDiscoveryTests
{
    [Fact]
    public async Task Controllers_are_discovered_when_the_entry_assembly_is_not_MqttForge_Api()
    {
        var entryAssemblyName = typeof(ControllerDiscoveryTests).Assembly.GetName().Name;
        var settingsPath = Path.Combine(Path.GetTempPath(), $"mqttforge-discovery-{Guid.NewGuid():N}.json");

        var app = MqttForgeHost.Build(
            [$"--applicationName={entryAssemblyName}", $"--MqttForge:SettingsPath={settingsPath}"],
            urls: "http://127.0.0.1:0");
        try
        {
            await app.StartAsync();

            var address = app.Services.GetRequiredService<IServer>()
                .Features.Get<IServerAddressesFeature>()!.Addresses.First();

            using var client = new HttpClient();
            using var response = await client.GetAsync($"{address}/api/connection");

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }
        finally
        {
            await app.StopAsync();
            if (File.Exists(settingsPath)) File.Delete(settingsPath);
        }
    }
}
