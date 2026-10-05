using System.Text.RegularExpressions;
using MqttForge.Desktop;

namespace MqttForge.UnitTests.Desktop;

/// <summary>Proves the first page shows the app's own lockup and can paint without asking for anything.</summary>
// Measured on the machine this was written for: the window is on screen a sixth of a second after
// launch and WebView2 cannot paint until about a second and a half, so this page is the first thing
// the browser ever draws in it. That is why it wears the mark, and why the one rule about it is that
// it must need nothing: a stylesheet, a webfont or an image would put a request against a host that
// may still be starting in front of the very frame the reader has been waiting for.
public sealed partial class SplashTests
{
    // Copied beside the tests from web/public/favicon.svg — see the test csproj — so these check the
    // drawing that actually ships.
    private static readonly string Favicon = File.ReadAllText(
        Path.Combine(AppContext.BaseDirectory, "fixtures", "brand", "favicon.svg"));

    private static string WithMark => Splash.Page(Splash.Inline(Favicon));

    [Fact]
    public void Carries_the_ground_the_console_itself_opens_on()
    {
        // web/src/styles/tokens.css --paper, which is what global.css paints the body. A splash in
        // any other colour swaps a black flash for a coloured one.
        Assert.Contains("background:#eaedf1", Splash.Page(null), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Wears_the_mark_the_rail_and_the_taskbar_wear()
    {
        var page = WithMark;

        // The petrol plate and the paper crossing: the two fills that make it this mark and not a
        // square. Checked against the favicon's own geometry rather than restated here.
        Assert.Contains("fill=\"#0e4260\"", page, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(PathData().Match(Favicon).Value, page, StringComparison.Ordinal);
    }

    [Fact]
    public void Sets_the_name_the_way_the_rail_does()
    {
        // MQTT in the grey the mark draws its F in, Forge in the plate's petrol — App.module.css
        // .wordmark. Checked as the markup that carries the two tones rather than as a string,
        // because a splash that said MQTTForge in one colour would be a different lockup.
        var page = Splash.Page(null);

        Assert.Contains("MQTT<span>Forge</span>", page, StringComparison.Ordinal);
        Assert.Contains("#6b7480", page, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Still_names_the_app_when_the_mark_cannot_be_read()
    {
        // A half-built tree, or a favicon that failed the check below: the reader still gets the
        // app's name on its own ground, which is most of what the mark was for.
        var page = Splash.Page(null);

        Assert.DoesNotContain("<svg", page, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Forge", page, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("<link", "a stylesheet")]
    [InlineData("<img", "an image")]
    [InlineData("<image", "an SVG image")]
    [InlineData("src=", "an external script or asset")]
    [InlineData("href", "a linked resource")]
    [InlineData("@import", "an imported stylesheet")]
    [InlineData("http", "an absolute URL")]
    public void Asks_the_network_for_nothing(string forbidden, string what)
    {
        // Every one of these costs a request against a host that, at the moment this page is shown,
        // may not have finished starting — the exact wait the splash exists to cover. The mark's
        // xmlns is the one http the favicon carries, and inline SVG in HTML does not need it.
        Assert.False(WithMark.Contains(forbidden, StringComparison.OrdinalIgnoreCase),
            $"the splash references {what} - that is a request against a host which may still be starting");
    }

    [Fact]
    public void Points_url_only_at_its_own_fragments()
    {
        // The plate clips the crossing with url(#…), which names an element on this page and fetches
        // nothing. Any other url() is a font or an image.
        Assert.DoesNotMatch(@"url\(\s*(?!#)", WithMark);
    }

    [Theory]
    [InlineData("<svg viewBox=\"0 0 24 24\"><image href=\"http://example.com/x.png\"/></svg>")]
    [InlineData("<svg viewBox=\"0 0 24 24\"><rect style=\"fill:url(http://example.com/p.svg#g)\"/></svg>")]
    [InlineData("<svg viewBox=\"0 0 24 24\"><script>alert(1)</script></svg>")]
    [InlineData("<svg viewBox=\"0 0 24 24\"><foreignObject><div/></foreignObject></svg>")]
    [InlineData("<svg viewBox=\"0 0 24 24\"><use href=\"#a\"/></svg>")]
    [InlineData("no svg in here at all")]
    public void Refuses_a_mark_that_would_fetch_or_run_something(string svg)
    {
        // The favicon is read from disk at start-up, so this is where the rule above is actually
        // enforced — the tests only prove it for the favicon that exists today. Refusing costs the
        // mark and nothing else; the page falls back to the name.
        Assert.Null(Splash.Inline(svg));
    }

    [Fact]
    public void Reads_the_mark_from_where_the_build_puts_the_interface()
    {
        // The desktop build copies the API's wwwroot beside the executable, favicon and all.
        var app = Directory.CreateTempSubdirectory("mqttforge-splash-");
        try
        {
            Directory.CreateDirectory(Path.Combine(app.FullName, "wwwroot"));
            File.WriteAllText(Path.Combine(app.FullName, "wwwroot", "favicon.svg"), Favicon);

            var mark = Splash.ReadMark(app.FullName);

            Assert.NotNull(mark);
            Assert.StartsWith("<svg", mark, StringComparison.Ordinal);
        }
        finally
        {
            app.Delete(recursive: true);
        }
    }

    [Fact]
    public void Treats_a_missing_favicon_as_no_mark_rather_than_a_failed_launch()
    {
        var app = Directory.CreateTempSubdirectory("mqttforge-splash-");
        try
        {
            Assert.Null(Splash.ReadMark(app.FullName));
        }
        finally
        {
            app.Delete(recursive: true);
        }
    }

    [Fact]
    public void Reports_the_frame_it_managed_to_draw()
    {
        // The console is not loaded until this arrives (see WindowBoot), so a splash that stopped
        // sending it would stay up for good.
        Assert.Contains(Splash.Painted, WithMark, StringComparison.Ordinal);
        Assert.Contains(Splash.Painted, Splash.Page(null), StringComparison.Ordinal);
    }

    // The loading line: a still lockup for a second and a half reads as a hang. The macOS window shows
    // this page, so the line is the page's there — out of the column, under the name, flowing.
    [Fact]
    public void Shows_it_is_still_loading_with_a_line_that_flows_under_the_name()
    {
        var page = Splash.Page(null);

        Assert.Contains("p::after{", page, StringComparison.Ordinal);
        Assert.Contains($"width:{Splash.FlowWidth}px;height:{Splash.FlowHeight}px", page, StringComparison.Ordinal);
        Assert.Contains($"top:calc(100% + {Splash.FlowGap}px)", page, StringComparison.Ordinal);
        Assert.Contains($"background:{Splash.Rule} linear-gradient({Splash.Petrol},{Splash.Petrol})", page, StringComparison.Ordinal);
        Assert.Contains($"animation:flow {Splash.FlowPeriodMs}ms", page, StringComparison.Ordinal);
        // Out of the column: absolutely placed, so the mark and the name stand where they did.
        Assert.Contains("position:absolute", page, StringComparison.Ordinal);
    }

    [Fact]
    public void Starts_the_flow_where_the_wall_clock_has_it()
    {
        // So the splash and the console's page, which on macOS draw this in turn, are at one point of
        // it when the second replaces the first, instead of the stretch jumping back to the start.
        Assert.Contains($"-(Date.now()%{Splash.FlowPeriodMs})+'ms'", Splash.Page(null), StringComparison.Ordinal);
        Assert.Equal(0.5, Splash.FlowPhase(DateTimeOffset.FromUnixTimeMilliseconds(Splash.FlowPeriodMs * 1000L + Splash.FlowPeriodMs / 2)));
    }

    [Fact]
    public void Leaves_the_line_to_the_window_on_windows()
    {
        // There the window draws the lockup and its line natively; a page line would be a second one.
        Assert.DoesNotContain("animation", Splash.Clear, StringComparison.Ordinal);
    }

    // On Windows the window draws the lockup itself for the whole of startup, and the splash is the
    // clear page in front of it: it has to exist, because its first frame is what says the browser is
    // there to be navigated, and it must draw nothing, because a second drawing of the lockup is the
    // one that jumped a pixel or two when it took over.
    [Fact]
    public void The_windows_splash_lets_the_window_show_through()
    {
        Assert.Contains("background:transparent", Splash.Clear, StringComparison.Ordinal);
        Assert.DoesNotContain("<svg", Splash.Clear, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("MQTT<span>", Splash.Clear, StringComparison.Ordinal);
        Assert.DoesNotContain(Splash.Paper, Splash.Clear, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void The_windows_splash_still_reports_the_browser_is_there()
    {
        Assert.Contains(Splash.Painted, Splash.Clear, StringComparison.Ordinal);
        Assert.Contains("requestAnimationFrame", Splash.Clear, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("<link")]
    [InlineData("src=")]
    [InlineData("href")]
    [InlineData("url(")]
    [InlineData("http")]
    public void The_windows_splash_asks_the_network_for_nothing(string forbidden)
    {
        Assert.DoesNotContain(forbidden, Splash.Clear, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Listens_for_the_message_the_console_sends()
    {
        // web/src/features/shell/shell.ts CONSOLE_DRAWN, posted by ConsoleReveal once the console is
        // on screen and covers the window. The two are pinned from both ends because nothing checks them against each
        // other: a mismatch leaves the window drawing its lockup under the console for good.
        Assert.Equal("console-painted", Splash.ConsoleDrawn);
    }

    [Fact]
    public void Stays_small_enough_to_be_a_first_frame()
    {
        // Not a budget anybody has to hit, just a tripwire: a splash that grew past a few kilobytes
        // has stopped being a held frame and become a second interface to maintain.
        Assert.True(WithMark.Length < 4096, $"splash is {WithMark.Length} bytes");
    }

    // The first path's data in the favicon: enough of the geometry to know the drawing arrived whole.
    [GeneratedRegex("d=\"[^\"]+\"")]
    private static partial Regex PathData();
}
