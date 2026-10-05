using System.Globalization;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace MqttForge.Desktop;

/// <summary>Gives a Windows window the console's ground wherever the browser has not drawn yet.</summary>
// Two things on Windows paint colours this app never uses, and both reach the screen.
//
// Photino's own window. Its WM_PAINT fills the client area with a brush chosen by the system theme —
// RGB(0,0,0) in dark mode, RGB(255,255,255) in light (Photino.Windows.cpp, darkBrush/lightBrush) —
// and the window is created without WS_CLIPCHILDREN, so that fill lands over the browser's area too
// until the browser redraws. It was the black a reader saw for two seconds at every launch, and after
// the window moved to being built off-screen, the 50 to 90ms of black each launch still showed the
// moment it came into view. The class brush is no help: the handler fills with its own brush and
// never looks at the class's, which is why swapping it was tried and did nothing. So the window
// procedure is wrapped and the two messages that paint the background are answered here instead.
//
// WebView2 underneath a page. Between one document and the next the browser shows its default
// background, which is white, and the splash is a different document from the console. That was one
// white frame at the hand-off, every launch. WebView2 reads that colour from
// WEBVIEW2_DEFAULT_BACKGROUND_COLOR; Photino never sets it unless asked for a transparent window, so
// the variable is honoured — and it is set transparent rather than to the ground, which does more
// than cure the white. Wherever a page paints nothing, the window's own painting shows through, so
// the lockup drawn here can stay the only one on screen from the window's first frame until the
// console's: the splash and the console's page both stay clear until then (Splash.Clear,
// web/src/features/shell). One drawing of the lockup, and nothing to hand over. There were two, and
// at 125% GDI+ and the browser set the name a pixel or two apart, so it jumped at the hand-off.
//
// Measured before and after on the same machine; both colours were in five launches of five.
public static class WindowGround
{
    /// <summary>The colour WebView2 is told to show under a page: fully transparent.</summary>
    // AARRGGBB with an alpha of 00, which WebView2 honours by showing the window through. It accepts
    // 00 or FF and nothing between; the colour after it is kept so the value still says what it is.
    public static string Transparent(string hex) => "00" + Digits(hex).ToUpperInvariant();

    /// <summary>The colour as GDI wants it: a COLORREF, 0x00BBGGRR.</summary>
    public static uint ColorRef(string hex)
    {
        var rgb = uint.Parse(Digits(hex), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture);
        return ((rgb & 0xFF) << 16) | (rgb & 0xFF00) | ((rgb >> 16) & 0xFF);
    }

    private static string Digits(string hex)
    {
        var digits = hex.TrimStart('#');
        if (digits.Length != 6 || !uint.TryParse(digits, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out _))
            throw new FormatException($"'{hex}' is not a six-digit colour");
        return digits;
    }

    /// <summary>Makes WebView2 show the window through any page that paints nothing, unless someone already chose otherwise.</summary>
    // Set on this process before the browser is created, which is when WebView2 reads it. An existing
    // value is left alone: it is the documented way to change the colour without a rebuild, and
    // someone who set it meant it.
    public static void ClearUnderTheBrowser(string hex)
    {
        const string Variable = "WEBVIEW2_DEFAULT_BACKGROUND_COLOR";
        if (Environment.GetEnvironmentVariable(Variable) is null)
            Environment.SetEnvironmentVariable(Variable, Transparent(hex));
    }

    /// <summary>Takes over painting the window's background, in this colour.</summary>
    // Called once, from Photino's window-created callback, which runs on the thread that owns the
    // window — the only thread allowed to swap its procedure. Everything but the two background
    // messages goes on to Photino exactly as before, the theme change included: that one ends in an
    // invalidate, which comes back here as a paint.
    //
    // With the lockup too, until ConsoleHasPainted: see NativeLockup. Null mark, and it is the name
    // alone, as the page is when it has none.
    [SupportedOSPlatform("windows")]
    public static void Install(IntPtr window, string hex, MarkDrawing? mark)
    {
        brush = CreateSolidBrush(ColorRef(hex));
        ground = System.Drawing.ColorTranslator.FromHtml(hex);
        lockup = mark;
        drawingLockup = true;

        // Held in a static for the life of the process: the native side keeps only the function
        // pointer, and a delegate the collector frees takes the window down with it the next time
        // anything moves the mouse over it.
        procedure = Paint;
        photino = SetWindowLongPtr(window, GwlpWndProc, Marshal.GetFunctionPointerForDelegate(procedure));

        // Whatever Photino has painted already goes, and the new paint happens now rather than when the
        // message loop gets round to it. The window is off-screen at this point and is moved into view
        // straight after, before that loop has started; left to it, the window's first frames in view
        // were an unpainted surface — white, for about fifty milliseconds, in five launches of five.
        InvalidateRect(window, IntPtr.Zero, true);
        UpdateWindow(window);

        // The loading line under the name moves, so the window is asked to repaint it every frame
        // for as long as the lockup is up. The timer belongs to this thread, which is the one that
        // owns the window; it is also the one that stops it, on the first tick after the console is
        // in — see WmTimer below.
        SetTimer(window, FlowTimer, FlowTickMs, IntPtr.Zero);
    }

    /// <summary>Something opaque now covers the window; from here it paints its ground alone.</summary>
    // Called when the console is on screen and covers the window (web/src/features/shell),
    // or when a page that paints its own ground replaces the splash — the start-up failure. Until then the pages in
    // front of the window are clear and this lockup is what shows through them. After it, the lockup
    // would be drawn where nobody sees it — except in the frames after a resize, before the browser
    // has caught up and with the browser now transparent, when a mark flashing under the console
    // would be a new thing to see rather than an old one gone.
    public static void ConsoleHasPainted() => drawingLockup = false;

    private static IntPtr brush;
    private static System.Drawing.Color ground;
    private static MarkDrawing? lockup;
    private static volatile bool drawingLockup;
    private static WindowProcedure? procedure;
    private static IntPtr photino;

    [SupportedOSPlatform("windows")]
    private static IntPtr Paint(IntPtr window, uint message, IntPtr wParam, IntPtr lParam)
    {
        switch (message)
        {
            case WmPaint:
                BeginPaint(window, out var paint);
                if (drawingLockup) DrawLockup(window, paint.Hdc, paint.Dirty);
                else FillRect(paint.Hdc, ref paint.Dirty, brush);
                EndPaint(window, ref paint);
                return IntPtr.Zero;

            case WmTimer when wParam == FlowTimer:
                if (!drawingLockup)
                {
                    KillTimer(window, FlowTimer);
                    return IntPtr.Zero;
                }

                // Only the line's own rectangle, a pixel wider all round for its anti-aliased edges:
                // the mark and the name do not change, and repainting them sixty times a second would
                // be work taken from the thread the browser is starting on.
                GetClientRect(window, out var area);
                var line = NativeLockup.FlowBounds(area.Right - area.Left, area.Bottom - area.Top, GetDpiForWindow(window) / 96f, lockup is not null);
                var dirty = new Rect
                {
                    Left = (int)Math.Floor(line.Left) - 1,
                    Top = (int)Math.Floor(line.Top) - 1,
                    Right = (int)Math.Ceiling(line.Right) + 1,
                    Bottom = (int)Math.Ceiling(line.Bottom) + 1,
                };
                InvalidateRect(window, ref dirty, false);
                return IntPtr.Zero;

            case WmEraseBackground:
                // Nothing: the paint that follows covers every pixel, and erasing first would show the
                // bare ground for a moment under the lockup each time the window is resized.
                // Non-zero, so Windows does not reach for the class brush instead.
                return 1;

            default:
                return CallWindowProc(photino, window, message, wParam, lParam);
        }
    }

    // Drawn off-screen and copied across whole, so a resize never shows the ground with the lockup
    // half drawn on it.
    [SupportedOSPlatform("windows")]
    private static void DrawLockup(IntPtr window, IntPtr dc, Rect dirty)
    {
        GetClientRect(window, out var client);
        var width = client.Right - client.Left;
        var height = client.Bottom - client.Top;
        if (width <= 0 || height <= 0) return;

        try
        {
            var scale = GetDpiForWindow(window) / 96f;
            var flow = Splash.FlowPhase(DateTimeOffset.UtcNow);
            var line = NativeLockup.FlowBounds(width, height, scale, lockup is not null);

            // The tick: only the line's rectangle is dirty, so only the line is drawn — into a buffer
            // the size of that rectangle, a few hundred pixels, rather than the whole client area with
            // the mark and the name drawn again unchanged. This is the thread the browser's start-up
            // reports back on, and nothing it has to do should wait behind pixels that did not change.
            // (Timed against a build with no line at all, over sixteen interleaved launches: no
            // difference that stood out from the browser's own variance.)
            if (dirty.Left >= line.Left - 2 && dirty.Top >= line.Top - 2 && dirty.Right <= line.Right + 2 && dirty.Bottom <= line.Bottom + 2)
            {
                var area = new System.Drawing.Rectangle(dirty.Left, dirty.Top, dirty.Right - dirty.Left, dirty.Bottom - dirty.Top);
                if (area.Width <= 0 || area.Height <= 0) return;
                using var small = System.Drawing.BufferedGraphicsManager.Current.Allocate(dc, area);
                small.Graphics.Clear(ground);
                small.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                NativeLockup.DrawFlow(small.Graphics, line, flow);
                small.Render(dc);
                return;
            }

            using var buffer = System.Drawing.BufferedGraphicsManager.Current.Allocate(
                dc, new System.Drawing.Rectangle(0, 0, width, height));
            buffer.Graphics.Clear(ground);
            NativeLockup.Draw(buffer.Graphics, width, height, scale, lockup, flow);
            buffer.Render(dc);
        }
        catch (Exception)
        {
            // This runs inside the window procedure, where an exception escaping into native code ends
            // the process. The lockup is a nicety and never a reason for the app not to open: fall back
            // to the plain ground, for this paint and every one after it.
            drawingLockup = false;
            FillRect(dc, ref client, brush);
        }
    }

    private const int GwlpWndProc = -4;
    private const uint WmPaint = 0x000F;
    private const uint WmEraseBackground = 0x0014;
    private const uint WmTimer = 0x0113;

    // An id of this app's own on Photino's window, and a tick of about one frame. Windows rounds the
    // interval to its timer resolution — 15.6ms by default — which is a frame at 64Hz.
    private static readonly IntPtr FlowTimer = new(0x4D46);
    private const uint FlowTickMs = 16;

    private delegate IntPtr WindowProcedure(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left, Top, Right, Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PaintStruct
    {
        public IntPtr Hdc;
        public int Erase;
        public Rect Dirty;
        public int Restore;
        public int IncUpdate;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)]
        public byte[] Reserved;
    }

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    private static extern IntPtr SetWindowLongPtr(IntPtr window, int index, IntPtr value);

    [DllImport("user32.dll", EntryPoint = "CallWindowProcW")]
    private static extern IntPtr CallWindowProc(IntPtr previous, IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern IntPtr BeginPaint(IntPtr window, out PaintStruct paint);

    [DllImport("user32.dll")]
    private static extern bool EndPaint(IntPtr window, ref PaintStruct paint);

    [DllImport("user32.dll")]
    private static extern int FillRect(IntPtr dc, ref Rect rect, IntPtr brush);

    [DllImport("user32.dll")]
    private static extern bool GetClientRect(IntPtr window, out Rect rect);

    [DllImport("user32.dll")]
    private static extern bool InvalidateRect(IntPtr window, IntPtr rect, bool erase);

    [DllImport("user32.dll")]
    private static extern bool InvalidateRect(IntPtr window, ref Rect rect, bool erase);

    [DllImport("user32.dll")]
    private static extern IntPtr SetTimer(IntPtr window, IntPtr id, uint elapse, IntPtr callback);

    [DllImport("user32.dll")]
    private static extern bool KillTimer(IntPtr window, IntPtr id);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateSolidBrush(uint colorRef);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool UpdateWindow(IntPtr window);
}
