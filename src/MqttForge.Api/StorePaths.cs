namespace MqttForge.Api;

/// <summary>Where the app keeps the three things it remembers between runs.</summary>
public static class StorePaths
{
    public const string ColourRulesFileName = "colour-rules.json";
    public const string ConnectionSettingsFileName = "connection-settings.json";
    public const string SavedProfilesFileName = "saved-brokers.json";

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

    private static string Beside(IConfiguration config, string fileName)
    {
        var directory = Path.GetDirectoryName(ConnectionSettings(config));

        return Path.Combine(
            string.IsNullOrEmpty(directory) ? AppContext.BaseDirectory : directory,
            fileName);
    }
}
