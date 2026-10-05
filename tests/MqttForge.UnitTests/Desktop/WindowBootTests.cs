using MqttForge.Desktop;

namespace MqttForge.UnitTests.Desktop;

/// <summary>Proves the console is loaded once both the browser and the host are ready, in either order.</summary>
// The host and the browser start at the same time and neither waits on the other: the host binds a
// port and reads its rules, the browser takes a second and a half to boot. The console can be loaded
// only once both are in — the host has to be listening, and the browser has to exist, because
// Photino cannot navigate a WebView2 that has not been attached yet (Photino.Windows.cpp says as much
// beside Show). The splash reporting its first frame is the one signal that proves the second.
//
// Which of the two arrives last depends on the machine, so both orders are ordinary and this is where
// the race lives.
public sealed class WindowBootTests
{
    private static readonly Uri Listening = new("http://192.168.1.5:5169");

    [Fact]
    public void Holds_the_url_back_until_the_browser_can_take_it()
    {
        var loaded = new List<Uri>();
        var boot = new WindowBoot(loaded.Add, _ => { });

        boot.HostIsUp(Listening);

        // Navigating a browser that has not been attached is at best dropped and at worst a crash in
        // native code, depending on how far Photino has got.
        Assert.Empty(loaded);
    }

    [Fact]
    public void Holds_the_url_back_until_the_host_answers()
    {
        var loaded = new List<Uri>();
        var boot = new WindowBoot(loaded.Add, _ => { });

        boot.RendererIsUp();

        // The splash is on screen by now; navigating to a host that is not listening would replace
        // it with the browser's own connection-refused page.
        Assert.Empty(loaded);
    }

    [Fact]
    public void Loads_when_the_host_is_last_to_arrive()
    {
        var loaded = new List<Uri>();
        var boot = new WindowBoot(loaded.Add, _ => { });

        boot.RendererIsUp();
        boot.HostIsUp(Listening);

        Assert.Equal([Listening], loaded);
    }

    [Fact]
    public void Loads_when_the_browser_is_last_to_arrive()
    {
        var loaded = new List<Uri>();
        var boot = new WindowBoot(loaded.Add, _ => { });

        boot.HostIsUp(Listening);
        boot.RendererIsUp();

        Assert.Equal([Listening], loaded);
    }

    [Fact]
    public void Loads_once_however_often_it_is_told()
    {
        var loaded = new List<Uri>();
        var boot = new WindowBoot(loaded.Add, _ => { });

        boot.RendererIsUp();
        boot.HostIsUp(Listening);
        boot.RendererIsUp();
        boot.HostIsUp(new Uri("http://10.0.0.9:5169"));

        // A second load throws away whatever the reader had already typed into the console.
        Assert.Equal([Listening], loaded);
    }

    [Fact]
    public void Shows_a_failure_in_the_window_rather_than_leaving_the_splash_up()
    {
        var loaded = new List<Uri>();
        var shown = new List<string>();
        var boot = new WindowBoot(loaded.Add, shown.Add);

        boot.RendererIsUp();
        boot.HostFailed("<body>no port</body>");

        Assert.Empty(loaded);
        Assert.Equal(["<body>no port</body>"], shown);
    }

    [Fact]
    public void Keeps_a_failure_waiting_for_the_browser_too()
    {
        var shown = new List<string>();
        var boot = new WindowBoot(_ => { }, shown.Add);

        boot.HostFailed("<body>no port</body>");
        Assert.Empty(shown);

        boot.RendererIsUp();
        Assert.Equal(["<body>no port</body>"], shown);
    }

    [Fact]
    public async Task Loads_exactly_once_when_both_report_at_the_same_moment()
    {
        // The real pair is a web message from the browser against a thread-pool continuation, so
        // they genuinely can land together. Run often enough that an unguarded pair of flags loses.
        for (var attempt = 0; attempt < 200; attempt++)
        {
            var loaded = 0;
            var boot = new WindowBoot(_ => Interlocked.Increment(ref loaded), _ => { });
            using var both = new Barrier(2);

            var renderer = Task.Run(() => { both.SignalAndWait(); boot.RendererIsUp(); });
            var host = Task.Run(() => { both.SignalAndWait(); boot.HostIsUp(Listening); });
            await Task.WhenAll(renderer, host);

            Assert.Equal(1, Volatile.Read(ref loaded));
        }
    }
}
