using MqttForge.Desktop;
using MqttForge.Domain.Abstractions;
using Microsoft.Extensions.DependencyInjection;
using Photino.NET;

// Spelled out rather than left to top-level statements, for the one attribute below. Windows builds
// a WebView2 out of COM, and COM hands a browser only to a thread in a single-threaded apartment;
// an entry point without [STAThread] runs MTA, and the window then opens, sizes itself, accepts a
// URL and stays black with nothing logged. Top-level statements cannot carry the attribute where it
// counts: the compiler names their entry point <Main>$, and an `await` anywhere in them makes it an
// async shim whose real body resumes on a thread-pool thread — MTA again — so the attribute would be
// undone even if it could be written. macOS and Linux draw with WebKit and have no apartments, which
// is why this costs a Windows user a black window and a Mac user nothing at all.
internal static class Program
{
    private const string InstanceName = "mqttforge-desktop";

    // Synchronous by deliberate design; see the apartment note above and WindowThread.
    [STAThread]
    private static int Main(string[] args)
    {
        // GUI launches don't guarantee cwd is the app dir; content root must be pinned to the executable
        Environment.CurrentDirectory = AppContext.BaseDirectory;

        // Read before anything is started, because this is the thread the window has to be opened on
        // and nothing below is allowed to drift off it. See WindowThread.
        var launchThread = Environment.CurrentManagedThreadId;

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
            "MQTTForge", "connection-settings.json");

        // The window is built first: the server's dialogs are the window's, and the services that offer
        // them have to be handed one before the first request can ask.
        var window = new PhotinoWindow()
            .SetTitle(WindowTitle.Name)
            .SetUseOsDefaultSize(false)
            .SetSize(1280, 860);

        // The window wears the mark as well as the tab inside it. macOS reads an app's icon from the
        // bundle it was launched from rather than from the window, so it is left to the .icns there;
        // Windows takes the one stamped into the executable, and only Linux needs telling at runtime.
        if (OperatingSystem.IsLinux())
        {
            var icon = Path.Combine(AppContext.BaseDirectory, "Resources", "MQTTForge.png");
            // Missing only in a half-built tree; a window with no icon is better than no window.
            if (File.Exists(icon)) window.SetIconFile(icon);
        }

        // Windows only: built out of sight and brought into view a moment later, once this app is the
        // one painting it. Photino's native constructor shows the window and paints it before it
        // returns — black in dark mode, white in light (Photino.Windows.cpp, Show and WM_PAINT) — and
        // WindowCreated, the first point any of this code runs against the window, comes after that.
        // Off-screen, that first paint happens where nobody sees it. The move comes before the message
        // loop starts, so the window is on screen in its own colour from the first frame it is seen
        // in, a sixth of a second after launch. It used to wait off-screen for the browser as well,
        // which cost a second and a half of a taskbar icon with no window to go with it.
        //
        // Not on macOS or Linux: they draw the window through WebKit, never showed either colour, and
        // keep the placement they always had.
        if (OperatingSystem.IsWindows())
            window.SetUseOsDefaultLocation(false).SetLeft(-30000).SetTop(-30000);

        // Before the browser exists, which is when WebView2 reads it: transparent, so that wherever a
        // page paints nothing the window's own painting shows. See WindowGround.
        if (OperatingSystem.IsWindows()) WindowGround.ClearUnderTheBrowser(Splash.Paper);

        // Set before the window is built, so it is the browser's start document and arrives in the
        // first frame the browser can produce rather than in a navigation after it. See Splash.
        // On Windows the window draws the lockup itself for the whole of startup and this page is
        // clear in front of it; elsewhere there is no native drawing and the page is the lockup.
        var mark = Splash.ReadMark(AppContext.BaseDirectory);
        window.LoadRawString(OperatingSystem.IsWindows() ? Splash.Clear : Splash.Page(mark));

        // The browser and the host are both waited on and neither needs the other's answer, so they
        // run together and WindowBoot loads the console when the second one arrives. Invoke marshals
        // onto the window thread: both report from elsewhere, and Photino accepts a navigation from
        // nowhere else.
        var boot = new WindowBoot(
            listening => window.Invoke(() => window.Load(listening)),
            html =>
            {
                // The failure page paints its own ground, so the window's lockup is behind something
                // opaque from here and the console that would have ended it is never coming.
                WindowGround.ConsoleHasPainted();
                window.Invoke(() => window.LoadRawString(html));
            });

        window.RegisterWindowCreatedHandler((_, _) =>
        {
            if (!OperatingSystem.IsWindows()) return;

            // In this order: the ground and the lockup first, so the window has this app's own face
            // to show in the first frame after it moves. Centre is Photino's own — the primary
            // monitor — which is where the window has opened since it stopped being placed by the OS.
            WindowGround.Install(window.WindowHandle, Splash.Paper, mark is null ? null : MarkDrawing.Read(mark));
            window.Center();
        });
        window.RegisterWebMessageReceivedHandler((_, message) =>
        {
            // The splash's first frame: the browser exists and can be navigated. The window's lockup
            // carries on — the splash is clear, and so is the console's page until it is drawn.
            if (message == Splash.Painted) boot.RendererIsUp();

            // The console is on screen and covers the whole window, so the window's own drawing of
            // the lockup, and the loading line under it, can stop.
            if (message == Splash.ConsoleDrawn) WindowGround.ConsoleHasPainted();

            // The console's title, which says the link: the window does not take the document's by
            // itself. See WindowTitle.
            if (WindowTitle.Read(message) is { } title) window.SetTitle(title);
        });

        // Handed to a thread rather than run here, which is the whole of the speed-up. This used to
        // run to completion before the window was built at all, so its three quarters of a second —
        // two and a half on a slow run — was spent in front of a window that then needed another two
        // seconds of browser boot before it could draw anything. Alongside, it costs nothing
        // visible: the browser is the longer wait on every machine measured.
        var startUp = Task.Run(() =>
        {
            try
            {
                // WindowThread.Wait and not await, for the reason WindowThread gives: this thread is
                // the one the host's start-up runs on, and an await would scatter the rest of this
                // block across the pool while the window waits to hear from it.
                var started = WindowThread.Wait(DesktopBind.StartAsync(
                    args, settingsPath, 5169,
                    picker: new WindowFolderPicker(window),
                    files: new WindowFilePicker(window)));

                if (started.Outcome == DesktopBind.Outcome.Unavailable)
                {
                    // Nothing bindable; the window says why instead of holding the splash up for good
                    boot.HostFailed(Splash.Failure(
                        "MQTTForge could not start",
                        "The OS refused to bind its local server on any address, including loopback. " +
                        "Check firewall or network-filtering settings, then relaunch."));
                }
                else
                {
                    boot.HostIsUp(DesktopBind.PageAddress(started.Outcome, started.Port));
                }

                return started;
            }
            catch (Exception ex)
            {
                // There was no window to say this in before, so an unexpected start-up failure
                // crashed the process and the reader saw whatever Windows chose to show. There is a
                // window now, and a splash left up for good reads as a hang, so it goes where the
                // reader is already looking. Rethrown so the exit code below still reports it.
                boot.HostFailed(Splash.Failure("MQTTForge could not start", ex.Message));
                throw;
            }
        });

        // The listener runs off the window thread, so the focus call has to be marshalled back.
        instance.ListenForSignals(() => window.Invoke(() =>
        {
            window.SetMinimized(false);
            window.SetTopMost(true);
            window.SetTopMost(false);
        }), shutdown.Token);

        // Everything above is synchronous on purpose; this says so out loud rather than hanging if some
        // later edit puts an await in front of the window.
        WindowThread.EnsureStillOn(launchThread);

        window.WaitForClose();
        WindowThread.Wait(shutdown.CancelAsync());

        // Release the lock before the slow shutdown work, so a relaunch during it gets its own window
        instance.Dispose();

        // A window closed while the host was still starting leaves that start-up running, and there
        // is nothing to shut down until it has finished one way or the other. Waited rather than
        // abandoned: the host owns a bound socket and a broker session, and a process that exits
        // without closing either leaves the port held until the OS notices.
        if (startUp.IsFaulted)
        {
            // Already said in the window; no host was built, so there is nothing here to stop. The
            // code says so to whatever launched this.
            return 1;
        }

        var (app, outcome, _) = WindowThread.Wait(startUp);

        // Unavailable means the host never started; nothing to disconnect or stop
        if (outcome != DesktopBind.Outcome.Unavailable)
        {
            try
            {
                // Closes the broker session so it isn't left open after the window closes
                WindowThread.Wait(app.Services.GetRequiredService<IMqttConnectionManager>()
                    .DisconnectAsync(CancellationToken.None));
            }
            finally
            {
                // Runs even if DisconnectAsync throws, so the host still shuts down
                WindowThread.Wait(app.StopAsync());
            }
        }
        else
        {
            WindowThread.Wait(app.DisposeAsync().AsTask());
        }

        return 0;
    }
}
