using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace MqttForge.IntegrationTests.Support;

// Unique settings path per test class, so tests don't share saved settings
public sealed class MqttForgeApiFactory : WebApplicationFactory<Program>
{
    private readonly string _settingsPath;
    private readonly string _colourRulesPath;
    private readonly bool _ownsFiles;

    public MqttForgeApiFactory()
    {
        _settingsPath = Path.Combine(Path.GetTempPath(), $"mqttforge-api-{Guid.NewGuid():N}.json");
        // Pinned as well as the settings path. Left unset it would default to the settings file's
        // directory — the temp directory — where every test class would share one list of rules.
        _colourRulesPath = Path.Combine(Path.GetTempPath(), $"mqttforge-colours-{Guid.NewGuid():N}.json");
        _ownsFiles = true;
    }

    private MqttForgeApiFactory(string settingsPath, string colourRulesPath)
    {
        _settingsPath = settingsPath;
        _colourRulesPath = colourRulesPath;
        _ownsFiles = false;
    }

    /// <summary>
    /// A host pointed at files somebody else owns — for restarting "the same" app, or for
    /// starting one on a file the test wrote by hand. Disposing it leaves the files alone.
    /// </summary>
    /// <remarks>
    /// A method rather than a second constructor: xUnit refuses to build a class fixture from a
    /// type with more than one public constructor, and most of these tests take this as one.
    /// </remarks>
    public static MqttForgeApiFactory PointedAt(string settingsPath, string colourRulesPath) =>
        new(settingsPath, colourRulesPath);

    public string SettingsPath => _settingsPath;
    public string ColourRulesPath => _colourRulesPath;

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
        if (!disposing || !_ownsFiles) return;

        if (File.Exists(_settingsPath)) File.Delete(_settingsPath);
        if (File.Exists(_colourRulesPath)) File.Delete(_colourRulesPath);
    }
}
