using System.Text;

namespace MqttForge.Desktop;

/// <summary>Reads the title the console asks the window to take.</summary>
// The console keeps its title saying the link — 'MQTTForge — 127.0.0.1:1883', 'MQTTForge — not
// connected' — because the title bar, the taskbar button and Alt+Tab are where a reader looks for a
// window they are not looking at. In a browser the document's title is the tab's and nothing more is
// needed. Here it is not: WebView2 reports a title change and Photino passes none of it on, so the
// window would say 'MQTTForge' whatever the page said. The page sends the title as a message instead
// (web/src/features/connection/useWindowTitle.ts), and this is what reads it.
//
// Cleaned rather than trusted as it comes. The page is this app's own, but a title that carried a line
// break or ran to a paragraph would be drawn as one by the shell — and it always starts with the app's
// name, because a taskbar button that has lost the name is one a reader cannot find.
public static class WindowTitle
{
    /// <summary>What a message asking for a title starts with; the rest of it is the title.</summary>
    // web/src/features/shell/shell.ts WINDOW_TITLE.
    public const string Prefix = "window-title:";

    /// <summary>The app's name, which every title starts with and the window opens with.</summary>
    public const string Name = "MQTTForge";

    /// <summary>The longest title the window takes; a longer one is cut to this, ellipsis included.</summary>
    // Room for the name, a state and a long host name with its port; anything longer is a page that
    // has gone wrong, and the shell would cut it anyway.
    public const int Longest = 120;

    /// <summary>The title <paramref name="message"/> asks for, or null when it asks for none.</summary>
    public static string? Read(string? message)
    {
        if (message is null || !message.StartsWith(Prefix, StringComparison.Ordinal)) return null;

        var title = Clean(message.AsSpan(Prefix.Length));
        if (title.Length == 0) return Name;
        if (!title.StartsWith(Name, StringComparison.Ordinal)) title = $"{Name} — {title}";

        return title.Length <= Longest ? title : Cut(title);
    }

    // One line: control characters out, and any run of whitespace — a line break included — down to
    // one space, trimmed at both ends.
    private static string Clean(ReadOnlySpan<char> asked)
    {
        var line = new StringBuilder(asked.Length);
        var space = false;

        foreach (var c in asked)
        {
            if (char.IsWhiteSpace(c))
            {
                space = line.Length > 0;
                continue;
            }
            if (char.IsControl(c)) continue;

            if (space) line.Append(' ');
            space = false;
            line.Append(c);
        }

        return line.ToString();
    }

    // Cut to fit with an ellipsis, and never between the two halves of a surrogate pair — half of
    // one is not a character, and the shell draws it as a box.
    private static string Cut(string title)
    {
        var end = Longest - 1;
        if (char.IsHighSurrogate(title[end - 1])) end--;
        return string.Concat(title.AsSpan(0, end).TrimEnd(), "…");
    }
}
