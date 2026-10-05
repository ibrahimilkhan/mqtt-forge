using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Runtime.Versioning;

namespace MqttForge.Desktop;

/// <summary>The start-up lockup on Windows, drawn by the window itself from its first frame to the console's.</summary>
// The window is on screen a sixth of a second after launch and WebView2 cannot draw until about a
// second and a half, so for that stretch the window is all there is. It used to be its bare ground,
// which read as a blank white window. This draws the lockup into it instead — the mark, from the
// same favicon, and the name.
//
// And it goes on drawing it until the console is drawn. It used to hand over to the browser's own
// drawing of the same lockup on the splash page, and it was laid out to the pixel for that: the
// page's flexbox done by hand, the type set on the browser's advances and half-leading, the baseline
// rounded the way Edge was measured to round it. At 100% the two agreed exactly. At 125% they did
// not — GDI+ and DirectWrite set the name one or two pixels apart and hint it a pixel shorter or
// taller, and no arithmetic here reaches the second of those — so the name jumped at the hand-off.
// There is no hand-off now: the splash and the console's page are clear until the console is drawn
// (WindowGround, web/src/features/shell), and this is the only drawing of the lockup on Windows.
//
// The numbers are still Splash's, and the layout still the page's. The macOS window shows the
// page's lockup, and one app should open on one lockup; and nothing is gained by unpicking
// arithmetic that is right.
//
// Anti-aliased throughout. The mark is diagonals and rounded corners, and drawn with plain GDI they
// would be stepped.
[SupportedOSPlatform("windows")]
public static class NativeLockup
{
    /// <summary>Draws the lockup centred in a client area of this many device pixels.</summary>
    // Scale is the window's DPI over 96: the page is laid out in CSS pixels and the browser multiplies
    // them out, so this lays out in CSS pixels too and multiplies at the end.
    //
    // `flow` is where the loading line's stretch is in its period, 0 to 1 — Splash.FlowPhase.
    public static void Draw(Graphics graphics, int width, int height, float scale, MarkDrawing? mark, double flow = 0)
    {
        graphics.SmoothingMode = SmoothingMode.AntiAlias;
        graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
        // ClearType because WebView2 sets the page's type in it: compared against the browser's render of
        // the splash at the same size, grayscale left 214 pixels of the name off by more than a quarter
        // and ClearType 122. What is left is DirectWrite's shaping against GDI+'s, and not reachable
        // from here.
        graphics.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

        var viewWidth = width / scale;
        var viewHeight = height / scale;
        var line = (float)(Splash.NameSize * Splash.NameLineHeight);

        // The page drops the mark, and the gap with it, when it has none; so does this.
        var block = (mark is null ? 0 : Splash.MarkSize + Splash.Gap) + line;
        var top = (viewHeight - block) / 2;

        if (mark is not null)
        {
            // Rounded to whole device pixels, as the browser snaps a replaced element's box. Left at a
            // fraction, the plate's straight top edge lands part-way into a row and anti-aliases into a
            // pale line along it that the browser's drawing does not have.
            var x = Round((viewWidth - Splash.MarkSize) / 2 * scale);
            var y = Round(top * scale);
            DrawMark(graphics, mark, x, y, Splash.MarkSize * scale);
            top += Splash.MarkSize + Splash.Gap;
        }

        DrawName(graphics, viewWidth * scale, top * scale, line * scale, scale);
        DrawFlow(graphics, FlowBounds(width, height, scale, mark is not null), flow);
    }

    /// <summary>Where the loading line is, in device pixels: under the name, centred, out of the column.</summary>
    // The window repaints this rectangle alone on every tick of the flow (WindowGround), so it is
    // worked out once, here, from the same column Draw lays out.
    public static RectangleF FlowBounds(int width, int height, float scale, bool hasMark)
    {
        var line = (float)(Splash.NameSize * Splash.NameLineHeight);
        var block = (hasMark ? Splash.MarkSize + Splash.Gap : 0) + line;
        var lineBottom = (height / scale - block) / 2 + block;

        // On whole device pixels. A 2px line at 125% is 2.5 pixels, and left fractional it is drawn as
        // two solid rows and a pale third — a hairline gone soft, which is the one thing a hairline
        // must not be. The height rounds with it, and never to nothing.
        return new RectangleF(
            Round((width / scale - Splash.FlowWidth) / 2 * scale),
            Round((lineBottom + Splash.FlowGap) * scale),
            Round(Splash.FlowWidth * scale),
            Math.Max(1, Round(Splash.FlowHeight * scale)));
    }

    /// <summary>The loading line alone, at this point of its period.</summary>
    // The track, and the stretch flowing along it: from wholly off the left end to wholly off the
    // right, eased so it gathers, crosses and slows the way the page's own curve has it, and cut to
    // the track so only the part over it shows.
    //
    // Public on its own because it is repainted on its own: sixty times a second, for as long as the
    // lockup is up, and the mark and the name do not change between any two of them.
    public static void DrawFlow(Graphics graphics, RectangleF track, double flow)
    {
        using (var rule = new SolidBrush(ColorTranslator.FromHtml(Splash.Rule)))
            graphics.FillRectangle(rule, track);

        var eased = (float)(flow * flow * (3 - 2 * flow));
        var stretch = track.Width * (float)Splash.FlowSegment;
        var left = track.Left - stretch + eased * (track.Width + stretch);
        var shown = RectangleF.Intersect(track, new RectangleF(left, track.Top, stretch, track.Height));
        if (shown.Width <= 0) return;

        using var petrol = new SolidBrush(ColorTranslator.FromHtml(Splash.Petrol));
        graphics.FillRectangle(petrol, shown);
    }

    private static void DrawMark(Graphics graphics, MarkDrawing mark, float x, float y, float size)
    {
        var state = graphics.Save();
        try
        {
            graphics.TranslateTransform(x, y);
            graphics.ScaleTransform(size / (float)mark.Units, size / (float)mark.Units);

            using var plate = Plate((float)mark.Units, (float)mark.Corner);
            using (var ground = new SolidBrush(ColorTranslator.FromHtml(mark.Plate)))
                graphics.FillPath(ground, plate);

            // The arms run past the square on every side, as they do in the favicon, and the plate
            // trims them — the browser does it with the favicon's clip path, this with the same shape.
            graphics.SetClip(plate);
            foreach (var fill in mark.Fills)
            {
                using var shape = new GraphicsPath(FillMode.Winding);
                foreach (var run in fill.Runs)
                    shape.AddPolygon(run.Select(point => new PointF((float)point.X, (float)point.Y)).ToArray());
                using var brush = new SolidBrush(ColorTranslator.FromHtml(fill.Colour));
                graphics.FillPath(brush, shape);
            }
        }
        finally
        {
            graphics.Restore(state);
        }
    }

    // Half away from zero, the browser's way; see DrawName.
    private static float Round(float value) => MathF.Round(value, MidpointRounding.AwayFromZero);

    private static GraphicsPath Plate(float side, float corner)
    {
        var path = new GraphicsPath();
        if (corner <= 0)
        {
            path.AddRectangle(new RectangleF(0, 0, side, side));
            return path;
        }

        var arc = corner * 2;
        path.AddArc(0, 0, arc, arc, 180, 90);
        path.AddArc(side - arc, 0, arc, arc, 270, 90);
        path.AddArc(side - arc, side - arc, arc, arc, 0, 90);
        path.AddArc(0, side - arc, arc, arc, 90, 90);
        path.CloseFigure();
        return path;
    }

    // MQTT in the grey, Forge in the petrol, as the page's <p> and <span> have it.
    private static void DrawName(Graphics graphics, float width, float lineTop, float lineHeight, float scale)
    {
        using var face = new FontFamily(Splash.NameFace);
        using var font = new Font(face, Splash.NameSize * scale, FontStyle.Bold, GraphicsUnit.Pixel);
        var typographic = StringFormat.GenericTypographic;

        // Monospace, so one advance is every advance. CSS adds the letter-spacing after each character,
        // the last one included, and centres the run with it.
        var advance = graphics.MeasureString("M", font, PointF.Empty, typographic).Width;
        var step = advance + (float)(Splash.NameTracking * Splash.NameSize) * scale;
        const string Name = "MQTTForge";
        var x = (width - step * Name.Length) / 2;

        // Where the browser puts the baseline: the line box's top on a whole pixel, the font's ascent and
        // descent each rounded, and the leading above them rounded down. That is not read out of
        // Chromium — it is the rule that best fits where Edge actually drew this name in 25 renders
        // across five display scales and five window heights, and it lands on the browser's pixel in 18
        // of them and within one in the rest. Rounding is half away from zero, as the browser's is;
        // MathF.Round's default goes to even and moved the name a pixel whenever the line top fell on
        // a half.
        var em = face.GetEmHeight(FontStyle.Bold);
        var ascent = face.GetCellAscent(FontStyle.Bold) * font.Size / em;
        var descent = face.GetCellDescent(FontStyle.Bold) * font.Size / em;
        var baseline = Round(lineTop) + MathF.Floor((lineHeight - (Round(ascent) + Round(descent))) / 2) + Round(ascent);

        // GDI+ hangs the glyphs from the top of their unrounded cell, and with ClearType's grid fit it
        // sets them one pixel higher than that arithmetic says — measured in 25 cases of 25 once the
        // rounding above was right. The one pixel back is that measurement, not a guess.
        var y = baseline - ascent + 1;

        using var protocol = new SolidBrush(ColorTranslator.FromHtml(Splash.Protocol));
        using var petrol = new SolidBrush(ColorTranslator.FromHtml(Splash.Petrol));
        for (var i = 0; i < Name.Length; i++)
            graphics.DrawString(Name[i].ToString(), font, i < 4 ? protocol : petrol, x + i * step, y, typographic);
    }
}
