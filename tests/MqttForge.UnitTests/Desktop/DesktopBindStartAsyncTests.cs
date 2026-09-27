using System.Net;
using System.Net.Sockets;
using MqttForge.Desktop;

namespace MqttForge.UnitTests.Desktop;

// Exercises real bind attempts, unlike DesktopBindTests' pure Decide() table
public sealed class DesktopBindStartAsyncTests
{
    [Fact]
    public async Task Starts_on_the_lan_bind_when_nothing_is_holding_the_port()
    {
        var settingsPath = TempSettingsPath();
        var candidate = FreePortForTest();

        var (app, outcome, port) = await DesktopBind.StartAsync([], settingsPath, candidate);
        try
        {
            Assert.Equal(DesktopBind.Outcome.Lan, outcome);
            Assert.True(port >= candidate);
        }
        finally
        {
            await app.StopAsync();
            await app.DisposeAsync();
            CleanUp(settingsPath);
        }
    }

    [Fact]
    public async Task Falls_back_to_loopback_when_the_lan_bind_is_refused()
    {
        var settingsPath = TempSettingsPath();
        var candidate = FreePortForTest();

        // 10.255.255.254 isn't owned by this machine; binding fails the same way a
        // firewall/permission refusal does
        var unreachable = IPAddress.Parse("10.255.255.254");

        var (app, outcome, port) = await DesktopBind.StartAsync([], settingsPath, candidate, unreachable);
        try
        {
            Assert.Equal(DesktopBind.Outcome.LoopbackOnly, outcome);
            Assert.True(port >= candidate);
        }
        finally
        {
            await app.StopAsync();
            await app.DisposeAsync();
            CleanUp(settingsPath);
        }
    }

    [Fact]
    public async Task Reports_unavailable_when_neither_bind_address_works()
    {
        var settingsPath = TempSettingsPath();
        var candidate = FreePortForTest();
        var unreachable = IPAddress.Parse("10.255.255.254");

        var (app, outcome, _) = await DesktopBind.StartAsync(
            [], settingsPath, candidate, lanBindAddress: unreachable, loopbackBindAddress: unreachable);
        try
        {
            Assert.Equal(DesktopBind.Outcome.Unavailable, outcome);
        }
        finally
        {
            await app.DisposeAsync();
            CleanUp(settingsPath);
        }
    }

    // In a directory of its own, because every other store the app keeps goes beside the settings
    // file: in the temp directory itself, the alert engine's state was one file every run of this
    // class shared, written as each app stopped, and never taken away.
    private static string TempSettingsPath() =>
        Path.Combine(Directory.CreateTempSubdirectory("mqttforge-desktopbind-").FullName, "connection-settings.json");

    private static void CleanUp(string settingsPath)
    {
        var directory = Path.GetDirectoryName(settingsPath)!;
        if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
    }

    private static int FreePortForTest()
    {
        using var probe = new TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        return ((IPEndPoint)probe.LocalEndpoint).Port;
    }
}
