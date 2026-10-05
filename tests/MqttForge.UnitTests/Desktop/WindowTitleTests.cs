using System.Text;
using MqttForge.Desktop;

namespace MqttForge.UnitTests.Desktop;

/// <summary>Proves the window takes the title the console asks for, and only as one clean line.</summary>
// The title bar, the taskbar and Alt+Tab say the link because the console sends its title across — the
// window does not follow the document's title by itself, since Photino passes none of WebView2's title
// changes on. See WindowTitle.
public sealed class WindowTitleTests
{
    [Fact]
    public void Takes_the_title_a_message_asks_for()
    {
        Assert.Equal(
            "MQTTForge — 127.0.0.1:1883",
            WindowTitle.Read("window-title:MQTTForge — 127.0.0.1:1883"));
    }

    [Theory]
    [InlineData("splash-painted")]
    [InlineData("console-painted")]
    [InlineData("")]
    [InlineData(null)]
    // The prefix has to lead: a message that only mentions it is not asking for anything.
    [InlineData("say window-title:MQTTForge")]
    public void Leaves_every_other_message_alone(string? message)
    {
        Assert.Null(WindowTitle.Read(message));
    }

    [Fact]
    public void Draws_a_line_break_as_a_space_rather_than_a_second_line()
    {
        Assert.Equal(
            "MQTTForge — connecting to broker.local:1883",
            WindowTitle.Read("window-title:MQTTForge — connecting\r\n  to broker.local:1883\t"));
    }

    [Fact]
    public void Drops_what_is_not_a_character_at_all()
    {
        Assert.Equal("MQTTForge — not connected", WindowTitle.Read("window-title:MQTTForge — not\u0007 connected\0"));
    }

    [Theory]
    [InlineData("window-title:")]
    [InlineData("window-title:   \n ")]
    public void Keeps_the_name_when_asked_for_nothing(string message)
    {
        Assert.Equal("MQTTForge", WindowTitle.Read(message));
    }

    // A taskbar button that has lost the app's name is one a reader cannot find.
    [Fact]
    public void Always_starts_with_the_name()
    {
        Assert.Equal("MQTTForge — console offline", WindowTitle.Read("window-title:console offline"));
    }

    [Fact]
    public void Cuts_a_runaway_title_to_one_that_fits()
    {
        var title = WindowTitle.Read($"window-title:MQTTForge — {new string('x', 500)}")!;

        Assert.Equal(WindowTitle.Longest, title.Length);
        Assert.EndsWith("x…", title, StringComparison.Ordinal);
    }

    [Fact]
    public void Never_cuts_a_character_in_half()
    {
        // Emoji are two UTF-16 units: laid so that a plain cut would land between the two.
        var asked = "MQTTForge — " + new string('x', WindowTitle.Longest - "MQTTForge — ".Length - 2) + "😀😀😀";

        var title = WindowTitle.Read("window-title:" + asked)!;

        Assert.True(title.Length <= WindowTitle.Longest);
        Assert.DoesNotContain(Rune.ReplacementChar, title.EnumerateRunes());
        foreach (var (c, i) in title.Select((c, i) => (c, i)))
        {
            if (char.IsHighSurrogate(c)) Assert.True(i + 1 < title.Length && char.IsLowSurrogate(title[i + 1]));
            if (char.IsLowSurrogate(c)) Assert.True(i > 0 && char.IsHighSurrogate(title[i - 1]));
        }
    }

    [Fact]
    public void Answers_to_the_prefix_the_console_sends()
    {
        // web/src/features/shell/shell.ts WINDOW_TITLE, which useWindowTitle puts in front of every
        // title it sends. The two sides are separate builds, so a rename on one side alone would leave
        // the window saying 'MQTTForge' forever and nothing failing.
        Assert.Equal("window-title:", WindowTitle.Prefix);
    }
}
