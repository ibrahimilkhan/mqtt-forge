namespace MqttForge.UnitTests.Desktop;

/// <summary>A test that opens the real desktop window, and is skipped unless asked for.</summary>
// Off by default, and off in CI — ci.yml runs the suite on ubuntu-latest, where there is no WebView2
// to find. Even on Windows this wants a desktop session, an installed Evergreen runtime and a
// firewall that lets the app bind; it steals focus for a few seconds and closes a window in front of
// whoever is watching. That is no way to treat somebody who only asked for `dotnet test`, and a
// suite that fails on a headless box teaches nobody anything.
//
// Run it deliberately:  MQTTFORGE_DESKTOP_SMOKE=1 dotnet test --filter DesktopWebViewSmoke
public sealed class DesktopSmokeFactAttribute : FactAttribute
{
    public DesktopSmokeFactAttribute()
    {
        // Skipped rather than returned early from the test body: an early return is reported as a
        // pass, and somebody running the documented command on a Mac would be told the browser
        // started when nothing was even looked at.
        if (!OperatingSystem.IsWindows())
            Skip = "Windows only - macOS and Linux draw with WebKit and have no msedgewebview2.exe.";
        else if (!Enabled)
            Skip = "Set MQTTFORGE_DESKTOP_SMOKE=1 to open a real MQTTForge window.";
    }

    public static bool Enabled =>
        Environment.GetEnvironmentVariable("MQTTFORGE_DESKTOP_SMOKE") is "1" or "true";
}
