using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace MqttForge.IntegrationTests.Support;

// Every store of its own, so tests don't share saved settings, and all of them in one directory of
// the factory's own, which goes with the factory.
public sealed class MqttForgeApiFactory : WebApplicationFactory<Program>
{
    // What this factory made paths for lives here, and nothing else: a path a caller hands in is
    // the caller's, wherever it is. Named apart from the app's own file names, so a host pointed at
    // this factory's settings alone — whose other stores go beside the settings file — keeps files
    // of its own here rather than sharing this factory's.
    private readonly string _directory;

    private readonly string _settingsPath;
    private readonly string _colourRulesPath;
    private readonly string _savedProfilesPath;
    private readonly string _alertRulesPath;
    private readonly string _alertStatePath;
    private readonly string _reconnectPath;
    private readonly string _flowsPath;
    private readonly string _installTokenPath;

    public MqttForgeApiFactory()
    {
        _directory = Directory.CreateTempSubdirectory("mqttforge-api-").FullName;
        _settingsPath = Own("api-settings.json");
        // Pinned as well as the settings path. Left unset it would default to the settings file's
        // directory, and a host pointed at these settings from elsewhere would share it.
        _colourRulesPath = Own("api-colours.json");
        // And the saved brokers, for the same reason. This one bites harder: the rules are
        // replaced whole by every test that writes them, and these accumulate.
        _savedProfilesPath = Own("api-brokers.json");
        // The alert rules, for the same reason again, and this one bites hardest of the three: an
        // enabled rule in a shared file would have every host this suite starts dial a broker on
        // its own and subscribe, in test classes that are about something else entirely.
        _alertRulesPath = Own("api-alert-rules.json");
        // The engine's own state. Not a preference and not a record — it is what a restart picks
        // an alarm back up from — so a shared one would have one class's ringing alarm restored
        // inside another's host.
        _alertStatePath = Own("api-alert-state.json");
        // The auto-reconnect option. A shared one would let a test that turned supervision
        // off leave every host started after it unsupervised, which is a failure that lands
        // in whichever class happens to run second.
        _reconnectPath = Own("api-reconnect.json");
        // The flows, for the reason every store above has its own file.
        _flowsPath = Own("api-flows.json");
        // And the install's own token, which is written the first time a client id is made up.
        _installTokenPath = Own("api-install-token.txt");
    }

    private MqttForgeApiFactory(
        string settingsPath, string colourRulesPath, string? savedProfilesPath,
        string? alertRulesPath, string? alertStatePath, string? reconnectPath, string? flowsPath)
    {
        _directory = Directory.CreateTempSubdirectory("mqttforge-api-").FullName;
        _settingsPath = settingsPath;
        _colourRulesPath = colourRulesPath;
        _savedProfilesPath = savedProfilesPath ?? Own("api-brokers.json");
        _alertRulesPath = alertRulesPath ?? Own("api-alert-rules.json");
        _alertStatePath = alertStatePath ?? Own("api-alert-state.json");
        _reconnectPath = reconnectPath ?? Own("api-reconnect.json");
        _flowsPath = flowsPath ?? Own("api-flows.json");
        _installTokenPath = Own("api-install-token.txt");
    }

    /// <summary>
    /// A host pointed at files somebody else owns — for restarting "the same" app, or for
    /// starting one on a file the test wrote by hand. Disposing it leaves those files alone, and
    /// takes away only the ones it made itself for what the caller left out.
    /// </summary>
    /// <remarks>
    /// A method rather than a second constructor: xUnit refuses to build a class fixture from a
    /// type with more than one public constructor, and most of these tests take this as one.
    /// The optional paths keep every existing caller compiling; each one a caller leaves out still
    /// gets a private path rather than a shared default. They used to be taken for the caller's too,
    /// and left behind: the alert state, written as every host stops, stayed in the temp directory
    /// once for every host started this way.
    /// </remarks>
    public static MqttForgeApiFactory PointedAt(
        string settingsPath, string colourRulesPath, string? savedProfilesPath = null,
        string? alertRulesPath = null, string? alertStatePath = null,
        string? reconnectPath = null, string? flowsPath = null) =>
        new(settingsPath, colourRulesPath, savedProfilesPath, alertRulesPath, alertStatePath, reconnectPath, flowsPath);

    public string SettingsPath => _settingsPath;
    public string ColourRulesPath => _colourRulesPath;
    public string SavedProfilesPath => _savedProfilesPath;
    public string AlertRulesPath => _alertRulesPath;
    public string AlertStatePath => _alertStatePath;
    public string ReconnectPath => _reconnectPath;
    public string FlowsPath => _flowsPath;

    private string Own(string file) => Path.Combine(_directory, file);

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
                ["MqttForge:FlowsPath"] = _flowsPath,
                ["MqttForge:InstallTokenPath"] = _installTokenPath,

                // Off unless a test turns it back on. The product ships with webhooks enabled and
                // deliberately does not block local addresses — so a rules file with a webhook in
                // it would have the suite POST to an address on whichever machine is running it.
                // Nothing reads this key until task 7 gives it a home on AlertEngineOptions; it is
                // set here from the start so that the answer is already 'no' the first time
                // anything asks.
                ["MqttForge:AllowWebhooks"] = "false"
            }));
    }

    // After the base, which stops the host first — a sync Dispose from xUnit included, since
    // WebApplicationFactory runs DisposeAsync to the end and comes back through here — so the
    // alert state the engine writes as it stops, and the atomic write's temp file beside it when
    // that write was called off, are in the directory by the time it goes. Called twice on the way
    // out; the second finds nothing.
    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (!disposing) return;

        if (Directory.Exists(_directory)) Directory.Delete(_directory, recursive: true);
    }
}
