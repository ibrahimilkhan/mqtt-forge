using MqttForge.Desktop;

namespace MqttForge.UnitTests.Desktop;

/// <summary>Proves the window can read the mark out of the favicon well enough to draw it itself.</summary>
// For the second and a half before the browser can draw, the window paints the splash's lockup
// itself (NativeLockup), so it needs the mark as shapes rather than as markup. The reader accepts the
// vocabulary scripts/make-icons.mjs accepts — one rounded plate and straight-sided polygons in M, L,
// H and Z on the drawing's own square — and nothing else, for the reason that script gives: a mark
// that quietly lost half its drawing is worse than no mark.
public sealed class MarkDrawingTests
{
    // Copied beside the tests from web/public/favicon.svg — see the test csproj.
    private static readonly string Favicon = File.ReadAllText(
        Path.Combine(AppContext.BaseDirectory, "fixtures", "brand", "favicon.svg"));

    [Fact]
    public void Reads_the_plate_on_the_drawings_own_square()
    {
        var mark = MarkDrawing.Read(Favicon);

        Assert.NotNull(mark);
        Assert.Equal(24, mark.Units);
        Assert.Equal(5.4, mark.Corner);
        Assert.Equal("#0e4260", mark.Plate);
    }

    [Fact]
    public void Reads_the_crossing_and_the_F_in_their_own_colours()
    {
        var mark = MarkDrawing.Read(Favicon)!;

        Assert.Equal(["#eaedf1", "#6b7480"], mark.Fills.Select(fill => fill.Colour));
        // Ten quads cut the crossing and six the F — each a moveto and three lines.
        Assert.Equal([10, 6], mark.Fills.Select(fill => fill.Runs.Count));
        Assert.All(mark.Fills.SelectMany(fill => fill.Runs), run => Assert.Equal(4, run.Count));
    }

    [Fact]
    public void Keeps_the_points_where_the_favicon_puts_them()
    {
        var first = MarkDrawing.Read(Favicon)!.Fills[0].Runs[0];

        // "M10.91 -2L13.06 -2L11.05 7.2L8.9 7.2Z" — the arms run past the square and the plate clips
        // them, so negative and past-24 coordinates are the drawing, not a mistake.
        Assert.Equal([(10.91, -2), (13.06, -2), (11.05, 7.2), (8.9, 7.2)], first);
    }

    [Fact]
    public void Follows_a_horizontal_line_from_where_the_last_one_ended()
    {
        var mark = MarkDrawing.Read(
            "<svg viewBox=\"0 0 24 24\"><rect width=\"24\" height=\"24\" rx=\"4\" fill=\"#000000\"/>" +
            "<path d=\"M1 2L5 2L5 6H1Z\" fill=\"#ffffff\"/></svg>")!;

        Assert.Equal([(1, 2), (5, 2), (5, 6), (1, 6)], mark.Fills[0].Runs[0]);
    }

    [Theory]
    [InlineData("<svg viewBox=\"0 0 24 24\"><rect width=\"24\" height=\"24\" fill=\"#000\"/><path d=\"M1 1C2 2 3 3 4 4Z\" fill=\"#fff\"/></svg>", "a curve")]
    [InlineData("<svg viewBox=\"0 0 24 24\"><rect width=\"24\" height=\"24\" fill=\"#000\"/><path d=\"m1 1l2 2z\" fill=\"#fff\"/></svg>", "relative commands")]
    [InlineData("<svg viewBox=\"0 0 24 24\"><path d=\"M1 1L2 2Z\" fill=\"#fff\"/></svg>", "no plate")]
    [InlineData("<svg viewBox=\"0 0 24 24\"><rect width=\"24\" height=\"24\" fill=\"#000\"/><circle r=\"3\" fill=\"#fff\"/></svg>", "another kind of shape")]
    [InlineData("<svg viewBox=\"0 0 24 24\"><rect width=\"24\" height=\"24\" fill=\"#000\"/><path d=\"L1 1L2 2Z\" fill=\"#fff\"/></svg>", "a path without a moveto")]
    [InlineData("<svg><rect width=\"24\" height=\"24\" fill=\"#000\"/></svg>", "no square to draw on")]
    [InlineData("not a drawing", "nothing at all")]
    public void Draws_nothing_rather_than_part_of_a_mark(string svg, string what)
    {
        // Null means the window draws the name alone, as the page does when it has no mark.
        Assert.True(MarkDrawing.Read(svg) is null, $"read a mark out of {what}");
    }

    [Fact]
    public void Leaves_the_clip_definition_out_of_the_drawing()
    {
        // The favicon's <defs> holds a copy of the plate for the browser's clip path. Read as a shape,
        // it would be a second plate — the same trap make-icons.mjs steps around.
        var mark = MarkDrawing.Read(Favicon)!;

        Assert.Equal(2, mark.Fills.Count);
    }
}
