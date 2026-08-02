using System.Net;
using MQFaker.Desktop;
using MQFaker.Domain.Abstractions;
using Microsoft.Extensions.DependencyInjection;
using Photino.NET;

const string InstanceName = "mqfaker-desktop";

// A GUI launch (double-clicking the app, or macOS re-opening it) does not guarantee a
// working directory pointed at the app itself - it can be the user's home directory or
// root. WebApplication's default content root comes from the working directory, and the
// interface files ship next to this executable, so the two have to be pinned together
// explicitly rather than left to whatever launched the process.
Environment.CurrentDirectory = AppContext.BaseDirectory;

// A second launch should surface the window that is already open rather than start a
// rival host on a different port, which the user could not tell apart.
var instance = SingleInstance.TryAcquire(InstanceName);
if (instance is null)
{
    SingleInstance.SignalExisting(InstanceName, TimeSpan.FromSeconds(2));
    return 0;
}

using var shutdown = new CancellationTokenSource();

// A DMG mounts read-only, so settings live in the per-user data dir instead of next to the exe
var settingsPath = Path.Combine(
    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
    "MQFaker", "connection-settings.json");

var (app, outcome, port) = await DesktopBind.StartAsync(args, settingsPath, 5169);

var window = new PhotinoWindow()
    .SetTitle("MQFaker")
    .SetUseOsDefaultSize(false)
    .SetSize(1280, 860);

if (outcome == DesktopBind.Outcome.Unavailable)
{
    // Neither 0.0.0.0 nor 127.0.0.1 would bind - nothing to load, but the window still opens
    // and says why instead of the process exiting with no visible window at all.
    window.LoadRawString(
        "<body style=\"font-family: system-ui, sans-serif; padding: 2rem;\">" +
        "<h1>MQFaker could not start</h1>" +
        "<p>The OS refused to bind its local server on any address, including loopback. " +
        "Check firewall or network-filtering settings, then relaunch.</p></body>");
}
else
{
    // Loading at "localhost" would leave window.location on loopback even though the host is
    // reachable over the LAN - the Mobile panel's QR code depends on window.location alone, so
    // the window has to be pointed at an address a phone could use. LoopbackOnly means the LAN
    // bind was refused (denied network permission or firewall policy): the Mobile panel's
    // existing loopback message already explains why the QR code is unavailable there.
    var host = outcome == DesktopBind.Outcome.Lan ? LanAddress.ChooseForThisMachine() : IPAddress.Loopback;
    window.Load(new Uri($"http://{host}:{port}"));
}

// The listener runs off the window thread, so the focus call has to be marshalled back.
instance.ListenForSignals(() => window.Invoke(() =>
{
    window.SetMinimized(false);
    window.SetTopMost(true);
    window.SetTopMost(false);
}), shutdown.Token);

window.WaitForClose();
await shutdown.CancelAsync();

// Release the lock before the slow shutdown work, so a relaunch during it gets its own window
instance.Dispose();

// Unavailable means the host never started - nothing connected, nothing to stop.
if (outcome != DesktopBind.Outcome.Unavailable)
{
    try
    {
        // Close the broker session before the process leaves, so the broker is not left
        // holding one for a window that is gone.
        await app.Services.GetRequiredService<IMqttConnectionManager>()
            .DisconnectAsync(CancellationToken.None);
    }
    finally
    {
        // Must still run even if DisconnectAsync above throws - otherwise the host never
        // shuts down and the process is left hanging instead of exiting cleanly.
        await app.StopAsync();
    }
}
else
{
    await app.DisposeAsync();
}

return 0;
