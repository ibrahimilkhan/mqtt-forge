using System.Net;
using System.Net.Sockets;
using MQFaker.Api;
using Microsoft.AspNetCore.Builder;

namespace MQFaker.Desktop;

// Program.cs must still open a window even when the OS will not let Kestrel bind to
// 0.0.0.0 - macOS Local Network permission refusal and firewall/Network-Extension policy
// both surface the same way empirically: a thrown SocketException/IOException out of
// StartAsync (verified by forcing a bind failure directly), not anything LanAddress could
// see in advance by enumerating interfaces. Kept pure so the three outcomes are ordinary
// unit tests instead of things that only reproduce with a live firewall rule.
public static class DesktopBind
{
    public enum Outcome { Lan, LoopbackOnly, Unavailable }

    // Pure: given what the two bind attempts already told us, decide the outcome.
    public static Outcome Decide(bool lanBindSucceeded, bool loopbackBindSucceeded) =>
        lanBindSucceeded ? Outcome.Lan :
        loopbackBindSucceeded ? Outcome.LoopbackOnly :
        Outcome.Unavailable;

    // Thin I/O layer: makes the real bind attempts Decide() above only reasons about
    // abstractly. The two bind-address parameters default to 0.0.0.0/127.0.0.1 for real use;
    // tests override them with an address this machine cannot bind to, forcing the same
    // SocketException a firewall or denied Local Network permission would produce, without
    // touching OS firewall state.
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

            // Nothing bindable anywhere - hand back an unstarted host purely so the tuple's
            // App is never null; the caller skips it entirely once it sees Unavailable.
            var fallback = Build(args, settingsPath, urls: null);
            return (fallback, Decide(lanBindSucceeded: false, loopbackBindSucceeded: false), candidatePort);
        }
    }

    private static WebApplication Build(string[] args, string settingsPath, string? urls) =>
        MqFakerHost.Build([.. args, $"--MqFaker:SettingsPath={settingsPath}"], urls: urls);
}
