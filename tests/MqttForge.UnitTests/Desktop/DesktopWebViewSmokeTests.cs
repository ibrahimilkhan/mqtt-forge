using System.Diagnostics;
using System.Runtime.InteropServices;
using MqttForge.Desktop;

namespace MqttForge.UnitTests.Desktop;

// DesktopEntryPointTests proves the attribute is still on the entry point; this proves the browser
// the attribute exists for actually starts. A black window has more causes than one missing
// attribute — a Photino native that never got copied, an absent Evergreen runtime, a WebView2Loader
// left out of a publish — and every one of them shows up here as a browser process that never came.
public sealed class DesktopWebViewSmokeTests
{
    // Hardcoded at Program.cs:9 and readable from nowhere else; the preflight below borrows it
    // deliberately, because there is no way to make the real app take a different one.
    private const string InstanceName = "mqttforge-desktop";

    // The existing ProjectReference to MqttForge.Desktop drops the apphost here. Launching it rather
    // than `dotnet MQTTForge.dll` keeps the launched process the app itself, so the parent-id lookup
    // below is one hop shorter and a failure names something a reader recognises.
    private static readonly string AppPath = Path.Combine(AppContext.BaseDirectory, "MQTTForge.exe");

    private const uint SnapProcess = 0x00000002;

    private static readonly IntPtr InvalidHandle = new(-1);

    [DesktopSmokeFact]
    public void A_browser_process_appears_under_the_window_that_was_launched()
    {
        Assert.True(File.Exists(AppPath), $"app not found at {AppPath} - build MqttForge.Desktop first");

        // An MQTTForge already open would make the launch below hand off to that window and exit at
        // once, with no browser of its own - byte for byte the regression's signature. Say so out
        // loud rather than failing cryptically or quietly passing, or the guard dies unnoticed on the
        // one developer who always has the app running.
        using (var held = SingleInstance.TryAcquire(InstanceName))
            Assert.True(held is not null, "MQTTForge is already running - close it and run this again");

        using var app = Start();
        try
        {
            var children = WaitForBrowserChildren(app, TimeSpan.FromSeconds(15));

            // An app that died on the way to its window has a different fault from one that opened
            // an empty one, and only one of them is the regression this guards. Saying "the window
            // is open and empty" about a process that is gone would send the next reader hunting the
            // wrong thing.
            Assert.False(app.HasExited,
                $"MQTTForge exited before a browser started, code {(app.HasExited ? app.ExitCode : 0)} "
                + "- it never got as far as the window this test is about");

            // Counting msedgewebview2.exe machine-wide would prove nothing: unrelated apps keep their
            // own, and a working box idles with more than a dozen. Only the app's own child counts.
            Assert.True(children > 0,
                "no msedgewebview2.exe started under MQTTForge - the window is open and empty");
        }
        finally
        {
            Stop(app);
        }
    }

    private static Process Start()
    {
        var psi = new ProcessStartInfo
        {
            FileName = AppPath,
            WorkingDirectory = AppContext.BaseDirectory,
            UseShellExecute = false,
        };

        return Process.Start(psi) ?? throw new InvalidOperationException("Failed to start MQTTForge.");
    }

    // The browser arrives well after the window does, so this waits for the signal instead of
    // sampling once; ten seconds was ample on every measured run, and the rest is slack for a cold
    // start that has to lay down a user-data folder first. An app that gives up early is not worth
    // waiting on, so its exit ends the wait too.
    private static int WaitForBrowserChildren(Process app, TimeSpan patience)
    {
        var deadline = DateTime.UtcNow + patience;
        while (true)
        {
            var children = BrowserChildrenOf(app.Id);
            if (children > 0 || app.HasExited || DateTime.UtcNow >= deadline) return children;

            Thread.Sleep(250);
        }
    }

    // .NET exposes no parent-process id and neither test project carries a WMI dependency, so a
    // Toolhelp snapshot is the cheapest honest way to ask what this process itself started.
    private static int BrowserChildrenOf(int parentId)
    {
        var snapshot = CreateToolhelp32Snapshot(SnapProcess, 0);
        if (snapshot == InvalidHandle) return 0;

        try
        {
            var entry = new ProcessEntry32 { dwSize = Marshal.SizeOf<ProcessEntry32>() };
            if (!Process32FirstW(snapshot, ref entry)) return 0;

            var found = 0;
            do
            {
                if (entry.th32ParentProcessID == parentId &&
                    string.Equals(entry.szExeFile, "msedgewebview2.exe", StringComparison.OrdinalIgnoreCase))
                    found++;
            }
            while (Process32NextW(snapshot, ref entry));

            return found;
        }
        finally
        {
            CloseHandle(snapshot);
        }
    }

    // Runs whatever the assertion decided, so a failure can't leave a window and half a dozen browser
    // processes sitting on the developer's desktop
    private static void Stop(Process app)
    {
        try
        {
            if (!app.HasExited) app.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException)
        {
            // Gone between the question and the answer; nothing left to kill
        }

        app.WaitForExit((int)TimeSpan.FromSeconds(10).TotalMilliseconds);
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry32 entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry32 entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    // Only two of these are ever read, but every one has to be declared: the OS validates dwSize
    // against the real PROCESSENTRY32W, and a short struct is refused rather than truncated.
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry32
    {
        public int dwSize;
        public int cntUsage;
        public int th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public int th32ModuleID;
        public int cntThreads;
        public int th32ParentProcessID;
        public int pcPriClassBase;
        public int dwFlags;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }
}
