using MQFaker.Api;
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

var port = PortFinder.FirstFree(5169);
var app = MqFakerHost.Build(
    [.. args, $"--MqFaker:SettingsPath={settingsPath}"],
    urls: $"http://0.0.0.0:{port}");
await app.StartAsync();

// Loading at "localhost" would leave window.location on loopback even though the host is
// reachable over the LAN - the Mobile panel's QR code depends on window.location alone, so
// the window has to be pointed at an address a phone could use. Falls back to loopback by
// itself when the machine has no such address, so the app still opens when offline.
var host = LanAddress.ChooseForThisMachine();
var window = new PhotinoWindow()
    .SetTitle("MQFaker")
    .SetUseOsDefaultSize(false)
    .SetSize(1280, 860)
    .Load(new Uri($"http://{host}:{port}"));

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

return 0;
