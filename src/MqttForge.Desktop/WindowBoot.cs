namespace MqttForge.Desktop;

/// <summary>Loads the console once both the browser and the host are ready, in either order.</summary>
// The launch used to be one queue: start the host, then build the window, then let the browser inside
// it start. Nothing in that order was required by anything — the host is binding a socket and
// reading its rules, the window is booting a browser — and stacking them cost their sum. They now run
// together and meet here.
//
// The console can be loaded only once both are in. The host has to be listening, or the navigation
// lands on the browser's own connection-refused page. And the browser has to exist: Photino attaches
// WebView2 asynchronously after the window is shown, and cannot navigate before that (its own comment
// beside Photino::Show says so). The splash reporting its first frame is what proves the browser is
// there, which is why the splash, not Photino's window-created signal, is the one listened for.
//
// Which arrives last varies by machine and by run, so both orders are ordinary and neither is the
// special case.
public sealed class WindowBoot(Action<Uri> navigate, Action<string> showHtml)
{
    // Guards the pair, not just each flag: the frame comes from a web message and the host from a
    // thread-pool continuation, so the two can land on different cores at once and a check written as
    // two plain reads lets both of them find the other's half missing.
    private readonly Lock gate = new();

    private bool painted;
    private Uri? url;
    private string? failure;
    private bool loaded;

    /// <summary>The browser has composited the splash, so it exists and can be navigated.</summary>
    public void RendererIsUp()
    {
        lock (gate) { painted = true; LoadIfReady(); }
    }

    /// <summary>The host is listening, at this address.</summary>
    public void HostIsUp(Uri listening)
    {
        // First answer wins: a second navigation would throw away whatever the reader had already
        // typed into the console.
        lock (gate) { url ??= listening; LoadIfReady(); }
    }

    /// <summary>Nothing could be bound, or start-up threw; this is what to say instead.</summary>
    // Without it a failed start-up leaves the splash up for good, which reads as a hang. That is a
    // failure mode the splash introduces, so it is the splash's job to answer for it.
    public void HostFailed(string html)
    {
        lock (gate) { failure ??= html; LoadIfReady(); }
    }

    // Called under the lock. The callbacks are the window's own Load/LoadRawString, marshalled onto the
    // window thread by the caller; Photino's Invoke returns without pumping the message loop, so
    // holding the lock across one cannot re-enter this.
    private void LoadIfReady()
    {
        if (loaded || !painted) return;

        if (failure is not null)
        {
            loaded = true;
            showHtml(failure);
        }
        else if (url is not null)
        {
            loaded = true;
            navigate(url);
        }
    }
}
