using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace MqttForge.IntegrationTests.Support;

// Unique settings path per test class, so tests don't share saved settings
public sealed class MqttForgeApiFactory : WebApplicationFactory<Program>
{
    private readonly string _settingsPath =
        Path.Combine(Path.GetTempPath(), $"mqttforge-api-{Guid.NewGuid():N}.json");

    // Pinned as well as the settings path. Left unset it would default to the settings file's
    // directory — the temp directory — where every test class would share one list of rules.
    private readonly string _colourRulesPath =
        Path.Combine(Path.GetTempPath(), $"mqttforge-colours-{Guid.NewGuid():N}.json");

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureAppConfiguration((_, config) =>
            config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["MqttForge:SettingsPath"] = _settingsPath,
                ["MqttForge:ColourRulesPath"] = _colourRulesPath
            }));
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (!disposing) return;

        if (File.Exists(_settingsPath)) File.Delete(_settingsPath);
        if (File.Exists(_colourRulesPath)) File.Delete(_colourRulesPath);
    }
}
