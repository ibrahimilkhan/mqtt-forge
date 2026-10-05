using System.Globalization;
using System.Text.RegularExpressions;

namespace MqttForge.Desktop;

/// <summary>One filled shape of the mark: its colour, and the polygons it is cut into.</summary>
public sealed record MarkFill(string Colour, IReadOnlyList<IReadOnlyList<(double X, double Y)>> Runs);

/// <summary>The mark as shapes, read from the favicon, for the window to draw before the browser can.</summary>
// The vocabulary is scripts/make-icons.mjs's, and deliberately no wider: one rounded rect for the
// plate, then straight-sided polygons written in absolute M, L, H and Z, all on the viewBox's own
// square. That is everything the favicon uses, and the one other reader of it in this repository
// already draws the line there. Anything else is refused whole — null, and the window draws the name
// alone — because a mark missing a piece is worse than a name without one.
//
// Regular expressions rather than an XML parser, as the script does: the favicon is a dozen lines
// the build copies verbatim, and the shapes are read by their attributes rather than their nesting.
public sealed partial record MarkDrawing(double Units, double Corner, string Plate, IReadOnlyList<MarkFill> Fills)
{
    public static MarkDrawing? Read(string svg)
    {
        var box = ViewBox().Match(svg);
        if (!box.Success || box.Groups[1].Value != box.Groups[2].Value) return null;
        var units = Number(box.Groups[1].Value);

        // The clip path's rect is a copy of the plate for the browser; read as a shape, it would be a
        // second plate laid over the first.
        var body = Definitions().Replace(svg, "");

        var shapes = Shape().Matches(body).Select(match => match.Value).ToList();
        if (shapes.Count < 2 || !shapes[0].StartsWith("<rect", StringComparison.Ordinal)) return null;

        var plate = Attribute(shapes[0], "fill");
        if (plate is null) return null;
        var corner = Attribute(shapes[0], "rx") is { } rx ? Number(rx) : 0;

        var fills = new List<MarkFill>();
        foreach (var shape in shapes.Skip(1))
        {
            if (!shape.StartsWith("<path", StringComparison.Ordinal)) return null;
            if (Attribute(shape, "fill") is not { } colour || Attribute(shape, "d") is not { } d) return null;
            if (Runs(d) is not { } runs) return null;
            fills.Add(new MarkFill(colour, runs));
        }

        return new MarkDrawing(units, corner, plate, fills);
    }

    // Absolute moveto, lineto, horizontal lineto and close; one list of points per subpath, the
    // closing point left implied, which is how a polygon is drawn anyway.
    private static List<IReadOnlyList<(double X, double Y)>>? Runs(string d)
    {
        var runs = new List<IReadOnlyList<(double X, double Y)>>();
        List<(double X, double Y)>? run = null;
        var consumed = 0;

        foreach (Match step in PathStep().Matches(d))
        {
            // Anything between two recognised steps is a command this reader does not speak.
            if (!string.IsNullOrWhiteSpace(d[consumed..step.Index])) return null;
            consumed = step.Index + step.Length;

            var numbers = step.Groups[2].Value.Split([' ', ','], StringSplitOptions.RemoveEmptyEntries)
                .Select(Number).ToList();

            switch (step.Groups[1].Value)
            {
                case "M" when numbers.Count == 2:
                    run = [(numbers[0], numbers[1])];
                    runs.Add(run);
                    break;
                case "L" when run is not null && numbers.Count == 2:
                    run.Add((numbers[0], numbers[1]));
                    break;
                case "H" when run is not null && numbers.Count == 1:
                    run.Add((numbers[0], run[^1].Y));
                    break;
                case "Z" when run is not null && numbers.Count == 0:
                    break;
                default:
                    return null;
            }
        }

        if (!string.IsNullOrWhiteSpace(d[consumed..]) || runs.Count == 0) return null;
        return runs;
    }

    private static double Number(string text) => double.Parse(text, CultureInfo.InvariantCulture);

    private static string? Attribute(string tag, string name)
    {
        var match = Regex.Match(tag, $@"\s{name}=""([^""]*)""");
        return match.Success ? match.Groups[1].Value : null;
    }

    // A square viewBox from the origin: the only kind the plate and its polygons are written for.
    [GeneratedRegex(@"viewBox=""0 0 ([\d.]+) ([\d.]+)""")]
    private static partial Regex ViewBox();

    [GeneratedRegex(@"<defs\b[\s\S]*?</defs>")]
    private static partial Regex Definitions();

    // Every drawn element, so an unexpected kind is seen and refused rather than skipped.
    [GeneratedRegex(@"<(rect|path|circle|ellipse|line|polyline|polygon|text|image|use)\b[^>]*>")]
    private static partial Regex Shape();

    [GeneratedRegex(@"([A-Za-z])\s*([-\d.,\s]*)")]
    private static partial Regex PathStep();
}
