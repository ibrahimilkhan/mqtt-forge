using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace MqttForge.IntegrationTests.Support;

// Unique settings path per test class, so tests don't share saved settings
public sealed class MqttForgeApiFactory : WebApplicationFactory<Program>
{
    private readonly string _settingsPath;
    private readonly string _colourRulesPath;
    private readonly string _savedProfilesPath;
    private readonly string _alertRulesPath;
    private readonly string _alertStatePath;
    private readonly string _reconnectPath;
    private readonly bool _ownsFiles;

    public MqttForgeApiFactory()
    {
        _settingsPath = Temp("api");
        // Pinned as well as the settings path. Left unset it would default to the settings file's
        // directory — the temp directory — where every test class would share one list of rules.
        _colourRulesPath = Temp("colours");
        // And the saved brokers, for the same reason. This one bites harder: the rules are
        // replaced whole by every test that writes them, and these accumulate.
        _savedProfilesPath = Temp("brokers");
        // The alert rules, for the same reason again, and this one bites hardest of the three: an
        // enabled rule in a shared file would have every host this suite starts dial a broker on
        // its own and subscribe, in test classes that are about something else entirely.
        _alertRulesPath = Temp("alert-rules");
        // The engine's own state. Not a preference and not a record — it is what a restart picks
        // an alarm back up from — so a shared one would have one class's ringing alarm restored
        // inside another's host.
        _alertStatePath = Temp("alert-state");
        // The auto-reconnect option. A shared one would let a test that turned supervision
        // off leave every host started after it unsupervised, which is a failure that lands
        // in whichever class happens to run second.
        _reconnectPath = Temp("reconnect");
        _ownsFiles = true;
    }

    private MqttForgeApiFactory(
        string settingsPath, string colourRulesPath, string savedProfilesPath,
        string alertRulesPath, string alertStatePath, string reconnectPath)
    {
        _settingsPath = settingsPath;
        _colourRulesPath = colourRulesPath;
        _savedProfilesPath = savedProfilesPath;
        _alertRulesPath = alertRulesPath;
        _alertStatePath = alertStatePath;
        _reconnectPath = reconnectPath;
        _ownsFiles = false;
    }

    /// <summary>
    /// A host pointed at files somebody else owns — for restarting "the same" app, or for
    /// starting one on a file the test wrote by hand. Disposing it leaves the files alone.
    /// </summary>
    /// <remarks>
    /// A method rather than a second constructor: xUnit refuses to build a class fixture from a
    /// type with more than one public constructor, and most of these tests take this as one.
    /// The three optional paths keep every existing caller compiling; each one a caller leaves
    /// out still gets a private temp path rather than a shared default.
    /// </remarks>
    public static MqttForgeApiFactory PointedAt(
        string settingsPath, string colourRulesPath, string? savedProfilesPath = null,
        string? alertRulesPath = null, string? alertStatePath = null,
        string? reconnectPath = null) =>
        new(settingsPath, colourRulesPath,
            savedProfilesPath ?? Temp("brokers"),
            alertRulesPath ?? Temp("alert-rules"),
            alertStatePath ?? Temp("alert-state"),
            reconnectPath ?? Temp("reconnect"));

    public string SettingsPath => _settingsPath;
    public string ColourRulesPath => _colourRulesPath;
    public string SavedProfilesPath => _savedProfilesPath;
    public string AlertRulesPath => _alertRulesPath;
    public string AlertStatePath => _alertStatePath;
    public string ReconnectPath => _reconnectPath;

    private static string Temp(string what) =>
        Path.Combine(Path.GetTempPath(), $"mqttforge-{what}-{Guid.NewGuid():N}.json");

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureAppConfiguration((_, config) =>
            config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["MqttForge:SettingsPath"] = _settingsPath,
                ["MqttForge:ColourRulesPath"] = _colourRulesPath,
                ["MqttForge:SavedProfilesPath"] = _savedProfilesPath,
                ["MqttForge:AlertRulesPath"] = _alertRulesPath,
                ["MqttForge:AlertStatePath"] = _alertStatePath,
                ["MqttForge:ReconnectOptionPath"] = _reconnectPath,

                // Off unless a test turns it back on. The product ships with webhooks enabled and
                // deliberately does not block local addresses — so a rules file with a webhook in
                // it would have the suite POST to an address on whichever machine is running it.
                // Nothing reads this key until task 7 gives it a home on AlertEngineOptions; it is
                // set here from the start so that the answer is already 'no' the first time
                // anything asks.
                ["MqttForge:AllowWebhooks"] = "false"
            }));
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (!disposing || !_ownsFiles) return;

        foreach (var path in new[]
                 {
                     _settingsPath, _colourRulesPath, _savedProfilesPath, _alertRulesPath,
                     _alertStatePath, _reconnectPath
                 })
            if (File.Exists(path)) File.Delete(path);
    }
}
