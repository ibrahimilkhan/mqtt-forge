namespace MqttForge.Api;

/// <summary>Where the app keeps the two things it remembers between runs.</summary>
public static class StorePaths
{
    public const string ColourRulesFileName = "colour-rules.json";
    public const string ConnectionSettingsFileName = "connection-settings.json";

    public static string ConnectionSettings(IConfiguration config) =>
        config["MqttForge:SettingsPath"]
        ?? Path.Combine(AppContext.BaseDirectory, ConnectionSettingsFileName);

    /// <summary>
    /// Beside the connection settings rather than in the base directory. The README's Docker
    /// recipe keeps settings by pointing MqttForge__SettingsPath at a mounted volume; deriving
    /// this from it means the same mount keeps the colours, with no second variable to find.
    /// </summary>
    public static string ColourRules(IConfiguration config)
    {
        var configured = config["MqttForge:ColourRulesPath"];
        if (!string.IsNullOrEmpty(configured)) return configured;

        var directory = Path.GetDirectoryName(ConnectionSettings(config));
        return Path.Combine(
            string.IsNullOrEmpty(directory) ? AppContext.BaseDirectory : directory,
            ColourRulesFileName);
    }
}
