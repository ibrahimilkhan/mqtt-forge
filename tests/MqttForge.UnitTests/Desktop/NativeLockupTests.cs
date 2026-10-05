using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.Versioning;
using MqttForge.Desktop;

namespace MqttForge.UnitTests.Desktop;

/// <summary>Proves the window's own copy of the lockup lands where the splash page puts it.</summary>
// On Windows the window draws the lockup itself from its first frame until the console is drawn,
// and it is the only drawing of it there. It is laid out on the splash page's numbers, which is the
// lockup macOS opens on, so these pin that arithmetic — the mark's box, the name's colours, the
// column centred in the window — at 100%, where it was measured against Edge's render of the page
// and agreed to the pixel.
//
// Windows only: GDI+ is. Returned from rather than skipped, as DesktopSubsystemTests does, because
// there is nothing on any other platform for them to be about. The attribute is for the analyzer,
// which reads System.Drawing as Windows 6.1 and later and cannot see through the early returns.
[SupportedOSPlatform("windows6.1")]
public sealed class NativeLockupTests
{
    private static readonly string Favicon = File.ReadAllText(
        Path.Combine(AppContext.BaseDirectory, "fixtures", "brand", "favicon.svg"));

    private const int Width = 1264;
    private const int Height = 821;

    [Fact]
    public void Puts_the_plate_in_the_box_the_page_gives_the_mark()
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(6, 1)) return;

        using var drawn = Draw(MarkDrawing.Read(Favicon));

        // The page: a column of 76 + 20 + 27.5, centred in 821 → the mark's box starts at 348.75,
        // which the browser snaps to 349, and 594 across. Measured against Edge at this size.
        var (left, top) = PlateCorner(drawn);
        Assert.Equal(594, left);
        Assert.Equal(349, top);
    }

    [Fact]
    public void Sets_the_name_in_the_rail_s_two_tones_under_the_mark()
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(6, 1)) return;

        using var drawn = Draw(MarkDrawing.Read(Favicon));
        var band = Colours(drawn, top: 349 + 76 + 20, bottom: 349 + 76 + 20 + 28);

        Assert.Contains(band, colour => Near(colour, Splash.Protocol));
        Assert.Contains(band, colour => Near(colour, Splash.Petrol));
    }

    [Fact]
    public void Leaves_the_rest_of_the_window_its_ground()
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(6, 1)) return;

        using var drawn = Draw(MarkDrawing.Read(Favicon));

        foreach (var (x, y) in new[] { (0, 0), (Width - 1, 0), (0, Height - 1), (Width - 1, Height - 1), (Width / 2, 100) })
            Assert.True(Near(drawn.GetPixel(x, y), Splash.Paper), $"({x},{y}) is not the ground");
    }

    [Fact]
    public void Centres_the_name_alone_when_there_is_no_mark()
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(6, 1)) return;

        using var drawn = Draw(mark: null);

        // As the page does with no <svg>: the column is one line, centred. The loading line under it
        // is out of the column — it does not move what it stands under — so it is left out here.
        var flow = NativeLockup.FlowBounds(Width, Height, 1f, hasMark: false);
        var inked = Enumerable.Range(0, Height)
            .Where(y => y < flow.Top - 1)
            .Where(y => Colours(drawn, y, y + 1).Any(c => !Near(c, Splash.Paper)))
            .ToList();
        Assert.NotEmpty(inked);
        Assert.InRange((inked[0] + inked[^1]) / 2.0, Height / 2.0 - 6, Height / 2.0 + 6);
        // One line of type and nothing else: a plate would make the inked band 76 pixels taller.
        Assert.True(inked[^1] - inked[0] < 40, $"inked from row {inked[0]} to {inked[^1]}");
    }

    // The window is all there is for the second and a half before the browser can draw, and a still
    // picture for that long reads as a hang. So a line under the name, with a stretch of it flowing
    // along the line and round again, the whole time the window is waiting.
    [Fact]
    public void Draws_a_line_under_the_name_while_it_waits()
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(6, 1)) return;

        using var drawn = Draw(MarkDrawing.Read(Favicon), flow: 0.5);
        var line = NativeLockup.FlowBounds(Width, Height, 1f, hasMark: true);
        var inLine = Colours(drawn, (int)line.Top, (int)Math.Ceiling(line.Bottom));

        // The track in the rule colour, and the flowing stretch in the plate's petrol.
        Assert.Contains(inLine, colour => Near(colour, Splash.Rule));
        Assert.Contains(inLine, colour => Near(colour, Splash.Petrol));

        // Under the name, not in it: the page puts the name's line box at 445 to 472.5.
        Assert.True(line.Top > 472.5f + 10, $"the line starts at {line.Top}");
        Assert.Equal(Width / 2f, line.Left + line.Width / 2, 1f);
    }

    [Fact]
    public void Moves_the_flowing_stretch_along_the_line_as_time_goes_on()
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(6, 1)) return;

        var line = NativeLockup.FlowBounds(Width, Height, 1f, hasMark: true);
        var centres = new[] { 0.3, 0.5, 0.7 }.Select(phase =>
        {
            using var drawn = Draw(MarkDrawing.Read(Favicon), phase);
            var row = (int)(line.Top + line.Height / 2);
            var petrol = Enumerable.Range((int)line.Left, (int)line.Width).Where(x => Near(drawn.GetPixel(x, row), Splash.Petrol)).ToList();
            Assert.NotEmpty(petrol);
            return petrol.Average();
        }).ToList();

        Assert.True(centres[0] < centres[1] && centres[1] < centres[2], string.Join(", ", centres));
    }

    private static Bitmap Draw(MarkDrawing? mark, double flow = 0)
    {
        var bitmap = new Bitmap(Width, Height, PixelFormat.Format32bppArgb);
        using var graphics = Graphics.FromImage(bitmap);
        graphics.Clear(ColorTranslator.FromHtml(Splash.Paper));
        NativeLockup.Draw(graphics, Width, Height, 1f, mark, flow);
        return bitmap;
    }

    // The plate's straight top edge: the first row, and its first column, with a run of solid petrol.
    private static (int Left, int Top) PlateCorner(Bitmap drawn)
    {
        for (var y = 0; y < Height; y++)
        {
            var run = Enumerable.Range(0, Width).Where(x => Near(drawn.GetPixel(x, y), Splash.Petrol)).ToList();
            if (run.Count > 20)
            {
                // The corners are rounded, so the leftmost petrol on the top edge is inset; the box's
                // left is the leftmost petrol anywhere in the plate's rows.
                var left = Enumerable.Range(y, 76)
                    .Min(row => Enumerable.Range(0, Width).FirstOrDefault(x => Near(drawn.GetPixel(x, row), Splash.Petrol), Width));
                return (left, y);
            }
        }

        throw new InvalidOperationException("no plate drawn");
    }

    private static List<Color> Colours(Bitmap drawn, int top, int bottom)
    {
        var colours = new List<Color>();
        for (var y = top; y < bottom; y++)
            for (var x = 0; x < Width; x += 2)
                colours.Add(drawn.GetPixel(x, y));
        return colours;
    }

    private static bool Near(Color colour, string hex)
    {
        var target = ColorTranslator.FromHtml(hex);
        return Math.Abs(colour.R - target.R) + Math.Abs(colour.G - target.G) + Math.Abs(colour.B - target.B) < 30;
    }
}
