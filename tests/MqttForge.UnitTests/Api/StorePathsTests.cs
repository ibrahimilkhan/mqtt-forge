using Microsoft.Extensions.Configuration;
using MqttForge.Api;

namespace MqttForge.UnitTests.Api;

public class StorePathsTests
{
    private static IConfiguration Config(params (string Key, string Value)[] entries) =>
        new ConfigurationBuilder()
            .AddInMemoryCollection(entries.ToDictionary(e => e.Key, e => (string?)e.Value))
            .Build();

    [Fact]
    public void Connection_settings_default_to_the_base_directory()
    {
        var path = StorePaths.ConnectionSettings(Config());

        Assert.Equal(Path.Combine(AppContext.BaseDirectory, "connection-settings.json"), path);
    }

    [Fact]
    public void A_configured_settings_path_is_taken_as_given()
    {
        var path = StorePaths.ConnectionSettings(Config(("MqttForge:SettingsPath", "/data/mine.json")));

        Assert.Equal("/data/mine.json", path);
    }

    // The README's Docker recipe mounts a volume by pointing SettingsPath at it. Colours follow
    // the settings there without a second variable, or the mount would keep one and lose the other.
    [Fact]
    public void Colour_rules_land_beside_the_configured_settings_file()
    {
        var path = StorePaths.ColourRules(Config(("MqttForge:SettingsPath", "/data/connection-settings.json")));

        Assert.Equal(Path.Combine("/data", "colour-rules.json"), path);
    }

    [Fact]
    public void Colour_rules_default_to_the_base_directory_when_nothing_is_configured()
    {
        var path = StorePaths.ColourRules(Config());

        Assert.Equal(Path.Combine(AppContext.BaseDirectory, "colour-rules.json"), path);
    }

    [Fact]
    public void An_explicit_colour_rules_path_wins_over_the_settings_directory()
    {
        var path = StorePaths.ColourRules(Config(
            ("MqttForge:SettingsPath", "/data/connection-settings.json"),
            ("MqttForge:ColourRulesPath", "/elsewhere/colours.json")));

        Assert.Equal("/elsewhere/colours.json", path);
    }

    // A bare filename has no directory part; the result must still be a usable path.
    [Fact]
    public void A_settings_path_with_no_directory_falls_back_to_the_base_directory()
    {
        var path = StorePaths.ColourRules(Config(("MqttForge:SettingsPath", "connection-settings.json")));

        Assert.Equal(Path.Combine(AppContext.BaseDirectory, "colour-rules.json"), path);
    }

    // The alert rules follow the settings for the reason the colours do: one mounted volume keeps
    // everything the app remembers, with no second variable to find.
    [Fact]
    public void Alert_rules_land_beside_the_configured_settings_file()
    {
        var path = StorePaths.AlertRules(Config(("MqttForge:SettingsPath", "/data/connection-settings.json")));

        Assert.Equal(Path.Combine("/data", "alert-rules.json"), path);
    }

    [Fact]
    public void An_explicit_alert_rules_path_wins_over_the_settings_directory()
    {
        var path = StorePaths.AlertRules(Config(
            ("MqttForge:SettingsPath", "/data/connection-settings.json"),
            ("MqttForge:AlertRulesPath", "/elsewhere/rules.json")));

        Assert.Equal("/elsewhere/rules.json", path);
    }

    [Fact]
    public void Alert_state_lands_beside_the_configured_settings_file()
    {
        var path = StorePaths.AlertState(Config(("MqttForge:SettingsPath", "/data/connection-settings.json")));

        Assert.Equal(Path.Combine("/data", "alert-state.json"), path);
    }

    // Two variables and not one, because the two files are not the same kind of thing: a
    // read-only rule set mounted from somewhere else, with the state going to a writable path, is
    // a reasonable thing to want and one variable would make it unsayable.
    [Fact]
    public void An_explicit_alert_rules_path_does_not_move_the_state_file()
    {
        var config = Config(
            ("MqttForge:SettingsPath", "/data/connection-settings.json"),
            ("MqttForge:AlertRulesPath", "/elsewhere/rules.json"));

        Assert.Equal(Path.Combine("/data", "alert-state.json"), StorePaths.AlertState(config));
    }

    [Fact]
    public void An_explicit_alert_state_path_is_taken_as_given()
    {
        var path = StorePaths.AlertState(Config(("MqttForge:AlertStatePath", "/var/run/state.json")));

        Assert.Equal("/var/run/state.json", path);
    }

    // The two defaults are asserted separately rather than in one method, because they are two
    // decisions: the day somebody gives the state file a home of its own the rules must not move
    // with it, and a single failing assertion that covered both would not say which had.
    [Fact]
    public void Alert_rules_default_to_the_base_directory_when_nothing_is_configured()
    {
        var path = StorePaths.AlertRules(Config());

        Assert.Equal(Path.Combine(AppContext.BaseDirectory, "alert-rules.json"), path);
    }

    [Fact]
    public void Alert_state_defaults_to_the_base_directory_when_nothing_is_configured()
    {
        var path = StorePaths.AlertState(Config());

        Assert.Equal(Path.Combine(AppContext.BaseDirectory, "alert-state.json"), path);
    }
}
