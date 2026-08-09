using System.Net;
using System.Net.Sockets;
using MqttForge.Api;
using Microsoft.AspNetCore.Builder;

namespace MqttForge.Desktop;

// SocketException/IOException means a firewall/Network Extension policy refused the bind —
// macOS's Local Network permission doesn't block bind(), so an unreachable LAN peer looks the same as success.
public static class DesktopBind
{
    public enum Outcome { Lan, LoopbackOnly, Unavailable }

    public static Outcome Decide(bool lanBindSucceeded, bool loopbackBindSucceeded) =>
        lanBindSucceeded ? Outcome.Lan :
        loopbackBindSucceeded ? Outcome.LoopbackOnly :
        Outcome.Unavailable;

    // Tests override the bind addresses with an unbindable one to simulate a firewall/permission
    // failure without touching real OS state
    public static async Task<(WebApplication App, Outcome Outcome, int Port)> StartAsync(
        string[] args,
        string settingsPath,
        int candidatePort,
        IPAddress? lanBindAddress = null,
        IPAddress? loopbackBindAddress = null)
    {
        lanBindAddress ??= IPAddress.Any;
        loopbackBindAddress ??= IPAddress.Loopback;

        var lanApp = default(WebApplication);
        try
        {
            var lanPort = PortFinder.FirstFree(candidatePort, lanBindAddress);
            lanApp = Build(args, settingsPath, $"http://{lanBindAddress}:{lanPort}");
            await lanApp.StartAsync();
            return (lanApp, Decide(lanBindSucceeded: true, loopbackBindSucceeded: false), lanPort);
        }
        catch (Exception ex) when (ex is SocketException or IOException)
        {
            if (lanApp is not null) await lanApp.DisposeAsync();
        }

        var loopbackApp = default(WebApplication);
        try
        {
            var loopbackPort = PortFinder.FirstFree(candidatePort, loopbackBindAddress);
            loopbackApp = Build(args, settingsPath, $"http://{loopbackBindAddress}:{loopbackPort}");
            await loopbackApp.StartAsync();
            return (loopbackApp, Decide(lanBindSucceeded: false, loopbackBindSucceeded: true), loopbackPort);
        }
        catch (Exception ex) when (ex is SocketException or IOException)
        {
            if (loopbackApp is not null) await loopbackApp.DisposeAsync();

            // Unstarted host only so App is never null; caller skips it on Unavailable
            var fallback = Build(args, settingsPath, urls: null);
            return (fallback, Decide(lanBindSucceeded: false, loopbackBindSucceeded: false), candidatePort);
        }
    }

    private static WebApplication Build(string[] args, string settingsPath, string? urls) =>
        MqttForgeHost.Build([.. args, $"--MqttForge:SettingsPath={settingsPath}"], urls: urls);
}
