using MqttForge.Desktop;

namespace MqttForge.UnitTests.Desktop;

/// <summary>Proves the two places a Windows window can show through get the console's ground.</summary>
// Photino paints its own window in whatever the system theme says — pure black in dark mode, pure
// white in light — and WebView2 paints white under a page it is still navigating to. Both showed:
// the black for the frames between the window coming into view and the browser redrawing into it,
// the white for the frame between the splash and the console. Measured, five launches of five.
//
// Neither colour is anything the reader will see again, which is the whole problem. The window
// paints --paper (and the lockup, through startup) itself, and the browser is made transparent so
// that the window is what shows wherever a page paints nothing. The two APIs spell a colour in two
// different orders.
public sealed class WindowGroundTests
{
    [Fact]
    public void Tells_WebView2_to_show_the_window_through_a_page_that_paints_nothing()
    {
        // WEBVIEW2_DEFAULT_BACKGROUND_COLOR is AARRGGBB, and an alpha of 00 is a transparent browser:
        // wherever a page draws no ground, the window's own painting shows. On Windows that is how
        // the window's startup lockup stays the only one on screen until the console is drawn —
        // see web/src/features/shell. WebView2 takes 00 or FF and nothing between.
        Assert.Equal("00EAEDF1", WindowGround.Transparent("#eaedf1"));
    }

    [Fact]
    public void Hands_GDI_its_colour_as_a_colorref()
    {
        // COLORREF is 0x00BBGGRR — the bytes run the other way from how the colour is written.
        // Reading it the obvious way paints #f1edea, which is close enough to pass a glance and
        // wrong enough to show as a warm band at the edge of every frame.
        Assert.Equal(0x00F1EDEAu, WindowGround.ColorRef("#eaedf1"));
    }

    [Theory]
    [InlineData("eaedf1")]
    [InlineData("#EAEDF1")]
    public void Reads_the_colour_however_it_is_written(string written)
    {
        Assert.Equal(0x00F1EDEAu, WindowGround.ColorRef(written));
        Assert.Equal("00EAEDF1", WindowGround.Transparent(written));
    }

    [Theory]
    [InlineData("#eaed")]
    [InlineData("#eaedf1ff")]
    [InlineData("#zzzzzz")]
    public void Refuses_anything_that_is_not_a_six_digit_colour(string written)
    {
        // Both callers pass a constant, so this is about the day someone edits one: a colour that
        // parses as something else would ship, and a thrown error at start-up would not.
        Assert.Throws<FormatException>(() => WindowGround.ColorRef(written));
    }

    [Fact]
    public void Is_the_splash_ground()
    {
        // The window, the browser underneath the page and the splash all have to be one colour, or
        // the hand-offs between them show as steps.
        Assert.Equal("#eaedf1", Splash.Paper);
    }
}
