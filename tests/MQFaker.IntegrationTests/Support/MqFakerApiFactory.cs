using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace MQFaker.IntegrationTests.Support;

// Unique settings path per test class, so tests don't share saved settings
public sealed class MqFakerApiFactory : WebApplicationFactory<Program>
{
    private readonly string _settingsPath =
        Path.Combine(Path.GetTempPath(), $"mqfaker-api-{Guid.NewGuid():N}.json");

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureAppConfiguration((_, config) =>
            config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["MqFaker:SettingsPath"] = _settingsPath
            }));
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing && File.Exists(_settingsPath)) File.Delete(_settingsPath);
    }
}
