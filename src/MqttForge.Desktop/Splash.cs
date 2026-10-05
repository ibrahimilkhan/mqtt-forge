using System.Globalization;
using System.Text.RegularExpressions;

namespace MqttForge.Desktop;

/// <summary>The frame the window holds while the console is still on its way.</summary>
// Measured on Windows 10 with the Evergreen runtime: the window is on screen a sixth of a second after
// launch, and WebView2 cannot paint until about a second and a half. That wait is a floor, not an
// oversight — there is no renderer yet, so there is nothing to paint with; the window shows its
// ground through it (see WindowGround). This page is the first thing the browser draws, so it is the
// first time the reader sees anything of the app in the window. Hence the mark.
//
// It must need nothing. A stylesheet, a webfont or an image would each put a request against the
// local host in front of the paint — and this is shown while that host may still be starting. So the
// mark is inlined rather than linked, and the type is the system's rather than the console's.
// SplashTests keeps it honest.
public static partial class Splash
{
    // web/src/styles/tokens.css: --paper is the ground global.css gives the body, --muted the ink
    // it gives quiet type. Copied rather than read because reading means either shipping a second
    // copy of the stylesheet or parsing the built 93KB one before the first frame, and both cost
    // more than the drift does: the worst a stale value here can do is a faint step in ground
    // colour at the swap.
    //
    // Public because the window and the browser under the page wear it too (see WindowGround): three
    // surfaces that take turns on screen during a launch, and any two that differ show as a step.
    public const string Paper = "#eaedf1";
    private const string Muted = "#606b82";

    // --ink, for the one line that has to be read rather than glanced at.
    private const string Ink = "#131a24";

    // The lockup's own two, from App.module.css .wordmark: the grey the mark draws its F in, and the
    // plate's petrol. Literals there for the reason they are literals here — they belong to the mark,
    // not to the theme.
    public const string Protocol = "#6b7480";
    public const string Petrol = "#0e4260";

    // The lockup's geometry, in CSS pixels. Public, and the page below is written from these rather
    // than from literals, because two things draw this lockup on the desktop — this page, and the
    // window itself for the second and a half before the browser can (NativeLockup) — and the second
    // hands over to the first mid-launch. Any number that differs between them is a pixel the mark
    // or the name jumps by at that moment. web/plugins/boot-lockup.ts is the third drawing, for the
    // console's own document, and restates these; its tests pin them.
    public const int MarkSize = 76;
    public const int Gap = 20;
    public const int NameSize = 22;
    public const double NameLineHeight = 1.25;
    public const double NameTracking = -0.03;

    // The loading line under the name: a hairline track, and a stretch of it in the plate's petrol
    // flowing from beyond its left end to beyond its right, over and over, for as long as the lockup
    // is up. A lockup that sits still for a second and a half reads as a hang; one with something
    // moving under it reads as a start. It hangs below the name's line box rather than joining the
    // column, so the mark and the name stand exactly where they stood without it.
    //
    // The period is wall-clock time, not time since the page loaded (FlowPhase), so that on macOS the
    // splash and the console's page, two documents drawing this in turn, are at the same point of it
    // when one replaces the other — rather than the stretch jumping back to the start.
    public const int FlowWidth = 112;
    public const int FlowHeight = 2;
    public const int FlowGap = 18;
    public const int FlowPeriodMs = 1400;
    public const double FlowSegment = 0.35;

    /// <summary>Where the flow is in its period at this moment, 0 to 1, by the wall clock.</summary>
    public static double FlowPhase(DateTimeOffset now) =>
        now.ToUnixTimeMilliseconds() % FlowPeriodMs / (double)FlowPeriodMs;

    // --rule, the track the stretch flows along.
    public const string Rule = "#d2d8e2";

    /// <summary>The name's face on Windows, which is what the page's font stack resolves to there.</summary>
    // ui-monospace is honoured only on Apple platforms, so on Windows the stack falls to Consolas.
    // Weight 600 has no Consolas face and resolves to its bold; NativeLockup asks for bold directly.
    public const string NameFace = "Consolas";

    /// <summary>What the splash sends once it has actually been drawn.</summary>
    // The console is not loaded until this arrives, because it is the one signal that proves the
    // browser exists and can be navigated (see WindowBoot) — and a splash that has been drawn is also
    // one the reader has had a chance to see. So it has to mean a frame the compositor has produced
    // rather than a document the parser has finished. Two nested requestAnimationFrame calls are the
    // usual way to say that: the first runs before the frame is painted, the second after.
    public const string Painted = "splash-painted";

    /// <summary>What the console sends once it is on screen in place of the lockup.</summary>
    // web/src/features/shell/shell.ts CONSOLE_DRAWN. The Windows window draws the lockup itself until
    // this arrives (WindowGround.ConsoleHasPainted), because until then every page in front of it is
    // clear. Both ends pin the string; nothing else checks them against each other.
    public const string ConsoleDrawn = "console-painted";

    /// <summary>The splash on Windows: a clear page, drawing nothing, that says when it has been drawn.</summary>
    // The window draws the lockup natively from its first frame, and WebView2 is told to show the
    // window through wherever a page paints nothing (WindowGround.ClearUnderTheBrowser). So this page
    // is there only for its first frame, which is the one signal that the browser exists and can be
    // navigated — see WindowBoot. Drawing the lockup here as well was a second drawing of it, by a
    // different renderer, taking over from the first: at 125% the name moved a pixel or two when it
    // did. macOS and Linux have no native drawing and keep Page below.
    public static string Clear { get; } =
        "<!doctype html><html style=\"background:transparent\"><head><meta charset=\"utf-8\">" +
        "<title>MQTTForge</title></head><body style=\"margin:0;background:transparent\">" +
        $"<script>requestAnimationFrame(()=>requestAnimationFrame(()=>window.external.sendMessage('{Painted}')))</script>" +
        "</body></html>";

    /// <summary>The whole page, inline and self-contained, with the mark above the name if there is one.</summary>
    // The rail's lockup stood on end: the mark, and the name beneath it in the rail's two tones. The
    // rail sets the name in the console's mono webfont; this cannot wait for a webfont, so it asks the
    // system for a monospace and gets Consolas or Menlo, which are close enough at this size to read
    // as the same name. Still, but for the loading line under the name (Flow*): one quiet thing
    // moving says the app is starting, where a spinner would make a show of it.
    public static string Page(string? mark) =>
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>MQTTForge</title><style>" +
        $"html,body{{height:100%;margin:0;background:{Paper}}}" +
        $"body{{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:{Gap}px}}" +
        // The plate's corners are its own; a size here and nothing else, so the drawing is the favicon's.
        $"svg{{width:{MarkSize}px;height:{MarkSize}px;display:block}}" +
        $"p{{margin:0;font:600 {NameSize}px/{Css(NameLineHeight)} ui-monospace,{NameFace},Menlo,monospace;" +
        $"letter-spacing:{Css(NameTracking)}em;color:{Protocol};position:relative}}" +
        $"p span{{color:{Petrol}}}" +
        // The loading line, hung off the name so the column does not grow for it. See Flow*.
        $"p::after{{content:'';position:absolute;left:50%;top:calc(100% + {FlowGap}px);" +
        $"width:{FlowWidth}px;height:{FlowHeight}px;margin-left:-{FlowWidth / 2}px;border-radius:1px;" +
        $"background:{Rule} linear-gradient({Petrol},{Petrol}) no-repeat;" +
        $"background-size:{Css(FlowSegment * 100)}% 100%;" +
        $"animation:flow {FlowPeriodMs}ms cubic-bezier(.45,0,.55,1) var(--flow-delay,0ms) infinite}}" +
        // From wholly off the track's left end to wholly off its right.
        $"@keyframes flow{{from{{background-position:{Css(Math.Round(-FlowSegment / (1 - FlowSegment) * 100, 2))}% 0}}" +
        $"to{{background-position:{Css(Math.Round(1 / (1 - FlowSegment) * 100, 2))}% 0}}}}" +
        "</style>" +
        // Where the flow is by the wall clock, before the first paint: see FlowPhase.
        $"<script>document.documentElement.style.setProperty('--flow-delay',-(Date.now()%{FlowPeriodMs})+'ms')</script>" +
        "</head><body>" +
        mark +
        "<p>MQTT<span>Forge</span></p>" +
        $"<script>requestAnimationFrame(()=>requestAnimationFrame(()=>window.external.sendMessage('{Painted}')))</script>" +
        "</body></html>";

    /// <summary>The mark, read from the favicon the build puts beside the executable.</summary>
    // Read rather than restated. web/src/features/brand/marks.tsx is explicit that the favicon is the
    // drawing every other copy of the mark is cut from, and that a copy which is edited separately is
    // simply wrong; a third copy pasted in here would be the one nobody remembered. The desktop build
    // copies the API's wwwroot next to the executable (MqttForge.Desktop.csproj, CopyFrontendAssets),
    // so the file is always where the host is going to serve it from anyway. A kilobyte off the local
    // disk costs nothing measurable against the two seconds the browser takes.
    //
    // Null when it is missing or unreadable — a half-built tree — and the page carries the name alone.
    // A splash is never a reason for the app not to start.
    public static string? ReadMark(string appDirectory)
    {
        try
        {
            return Inline(File.ReadAllText(Path.Combine(appDirectory, "wwwroot", "favicon.svg")));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>The favicon made fit to sit inline in this page, or null if it would fetch or run anything.</summary>
    // Two things change and one is checked. The xmlns goes, because inline SVG in HTML does not need
    // it and it is the one absolute URL the file carries. The whitespace between tags goes, because it
    // is a third of the file. And the rest is checked against everything that could make the first
    // frame wait on a request or run code: the tests prove that for the favicon that exists today,
    // and this proves it for whichever one is actually on disk when the app starts.
    public static string? Inline(string svg)
    {
        var start = svg.IndexOf("<svg", StringComparison.OrdinalIgnoreCase);
        if (start < 0) return null;

        var inline = NamespaceDeclaration().Replace(svg[start..], "");
        inline = BetweenTags().Replace(inline, "><").Trim();

        return Fetches().IsMatch(inline) ? null : inline;
    }

    /// <summary>What replaces the splash when the console is never going to arrive.</summary>
    // On the same ground as the splash, so a start-up that fails reads as this app saying something
    // rather than as a second, unrelated screen. Self-contained for the same reason the splash is:
    // the host it would fetch from is precisely the thing that did not start.
    public static string Failure(string headline, string detail) =>
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>MQTTForge</title><style>" +
        $"html,body{{height:100%;margin:0;background:{Paper}}}" +
        "body{display:flex;flex-direction:column;align-items:center;justify-content:center;" +
        "gap:.6rem;padding:2rem;text-align:center;" +
        "font:400 14px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;" +
        $"color:{Muted}}}" +
        $"h1{{margin:0;font-size:17px;font-weight:600;color:{Ink}}}" +
        "p{margin:0;max-width:46ch}" +
        $"</style></head><body><h1>{Escape(headline)}</h1><p>{Escape(detail)}</p></body></html>";

    // Invariant: a Turkish or German Windows writes 1.25 as "1,25", which CSS reads as two values.
    private static string Css(double value) => value.ToString(CultureInfo.InvariantCulture);

    // The detail can be an exception's message, which is not ours to trust as markup: a path or a
    // quoted host name with an angle bracket in it would otherwise be parsed rather than read.
    private static string Escape(string text) => text
        .Replace("&", "&amp;", StringComparison.Ordinal)
        .Replace("<", "&lt;", StringComparison.Ordinal)
        .Replace(">", "&gt;", StringComparison.Ordinal);

    [GeneratedRegex(@"\s+xmlns(:\w+)?\s*=\s*""[^""]*""")]
    private static partial Regex NamespaceDeclaration();

    [GeneratedRegex(@">\s+<")]
    private static partial Regex BetweenTags();

    // Anything that loads a resource or runs code. <use> goes with href: even pointed at a fragment it
    // can be pointed elsewhere, and this mark has never needed one. url() is allowed only at a
    // fragment, which is how the plate clips the crossing.
    [GeneratedRegex(@"<script|<image|<foreignObject|<use\b|href\s*=|src\s*=|url\(\s*(?!#)|@import|https?:",
        RegexOptions.IgnoreCase)]
    private static partial Regex Fetches();
}
