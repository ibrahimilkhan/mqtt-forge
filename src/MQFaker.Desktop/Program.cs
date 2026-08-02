using System.Net;
using MQFaker.Desktop;
using MQFaker.Domain.Abstractions;
using Microsoft.Extensions.DependencyInjection;
using Photino.NET;

const string InstanceName = "mqfaker-desktop";

// GUI launches don't guarantee cwd is the app dir; content root must be pinned to the executable
Environment.CurrentDirectory = AppContext.BaseDirectory;

// Surfaces the existing window instead of starting an indistinguishable rival host
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
    // Nothing bindable; window still opens to explain why instead of exiting silently
    window.LoadRawString(
        "<body style=\"font-family: system-ui, sans-serif; padding: 2rem;\">" +
        "<h1>MQFaker could not start</h1>" +
        "<p>The OS refused to bind its local server on any address, including loopback. " +
        "Check firewall or network-filtering settings, then relaunch.</p></body>");
}
else
{
    // Window loads a LAN address, not localhost, so the Mobile panel's window.location-based QR
    // code has something to encode — a successful bind doesn't guarantee a phone can reach it.
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

// Unavailable means the host never started; nothing to disconnect or stop
if (outcome != DesktopBind.Outcome.Unavailable)
{
    try
    {
        // Closes the broker session so it isn't left open after the window closes
        await app.Services.GetRequiredService<IMqttConnectionManager>()
            .DisconnectAsync(CancellationToken.None);
    }
    finally
    {
        // Runs even if DisconnectAsync throws, so the host still shuts down
        await app.StopAsync();
    }
}
else
{
    await app.DisposeAsync();
}

return 0;
