using System.Net;
using System.Net.Sockets;
using MqttForge.Api;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
using MqttForge.Domain.Abstractions;

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
        IPAddress? loopbackBindAddress = null,
        IFolderPicker? picker = null)
    {
        lanBindAddress ??= IPAddress.Any;
        loopbackBindAddress ??= IPAddress.Loopback;

        var lanApp = default(WebApplication);
        try
        {
            var lanPort = PortFinder.FirstFree(candidatePort, lanBindAddress);
            lanApp = Build(args, settingsPath, $"http://{lanBindAddress}:{lanPort}", picker);
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
            loopbackApp = Build(args, settingsPath, $"http://{loopbackBindAddress}:{loopbackPort}", picker);
            await loopbackApp.StartAsync();
            return (loopbackApp, Decide(lanBindSucceeded: false, loopbackBindSucceeded: true), loopbackPort);
        }
        catch (Exception ex) when (ex is SocketException or IOException)
        {
            if (loopbackApp is not null) await loopbackApp.DisposeAsync();

            // Unstarted host only so App is never null; caller skips it on Unavailable
            var fallback = Build(args, settingsPath, urls: null, picker);
            return (fallback, Decide(lanBindSucceeded: false, loopbackBindSucceeded: false), candidatePort);
        }
    }

    // The picker is the one thing the API cannot supply for itself: it belongs to the window,
    // and only a host that has one registers it.
    private static WebApplication Build(string[] args, string settingsPath, string? urls, IFolderPicker? picker) =>
        MqttForgeHost.Build(
            [.. args, $"--MqttForge:SettingsPath={settingsPath}"],
            urls: urls,
            configure: services =>
            {
                if (picker is not null) services.AddSingleton(picker);
            });
}
