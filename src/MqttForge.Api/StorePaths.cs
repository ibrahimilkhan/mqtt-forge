namespace MqttForge.Api;

/// <summary>Where the app keeps the six things it remembers between runs.</summary>
public static class StorePaths
{
    public const string ColourRulesFileName = "colour-rules.json";
    public const string ConnectionSettingsFileName = "connection-settings.json";
    public const string SavedProfilesFileName = "saved-brokers.json";
    public const string AlertRulesFileName = "alert-rules.json";
    public const string AlertStateFileName = "alert-state.json";
    public const string ReconnectOptionFileName = "reconnect.json";

    public static string ConnectionSettings(IConfiguration config) =>
        config["MqttForge:SettingsPath"]
        ?? Path.Combine(AppContext.BaseDirectory, ConnectionSettingsFileName);

    /// <summary>
    /// Beside the connection settings rather than in the base directory. The README's Docker
    /// recipe keeps settings by pointing MqttForge__SettingsPath at a mounted volume; deriving
    /// this from it means the same mount keeps the colours, with no second variable to find.
    /// </summary>
    public static string ColourRules(IConfiguration config) =>
        config["MqttForge:ColourRulesPath"] ?? Beside(config, ColourRulesFileName);

    /// <summary>
    /// The brokers somebody saved, beside the rest for the same reason: one mounted volume keeps
    /// everything the app remembers, with no second variable to find.
    /// </summary>
    public static string SavedProfiles(IConfiguration config) =>
        config["MqttForge:SavedProfilesPath"] ?? Beside(config, SavedProfilesFileName);

    /// <summary>
    /// The alert rules, beside the rest. Spec: "alert-rules.json, MqttForge:AlertRulesPath
    /// verilmemişse SettingsPath'in dizinine yazılır".
    /// </summary>
    public static string AlertRules(IConfiguration config) =>
        config["MqttForge:AlertRulesPath"] ?? Beside(config, AlertRulesFileName);

    /// <summary>
    /// The alarms that were still ringing when the process died. Its own variable, because it is
    /// not the same kind of file as the rules beside it: somebody mounting a read-only rule set
    /// and letting the state go to a writable path is a reasonable thing to want, and one
    /// variable for both would make it impossible.
    /// </summary>
    public static string AlertState(IConfiguration config) =>
        config["MqttForge:AlertStatePath"] ?? Beside(config, AlertStateFileName);

    /// <summary>
    /// Whether the broker link is supervised. Beside the rest, so one mounted volume still keeps
    /// everything the app remembers.
    /// </summary>
    // Only the option lives here. The rest of a ReconnectStatus is about an outage, and an outage
    // does not outlive the process that was living through it: a container coming back up holding
    // "attempt 4, next in 16 seconds" would be describing a broker nobody has tried yet.
    public static string ReconnectOption(IConfiguration config) =>
        config["MqttForge:ReconnectOptionPath"] ?? Beside(config, ReconnectOptionFileName);

    private static string Beside(IConfiguration config, string fileName)
    {
        var directory = Path.GetDirectoryName(ConnectionSettings(config));

        return Path.Combine(
            string.IsNullOrEmpty(directory) ? AppContext.BaseDirectory : directory,
            fileName);
    }
}
