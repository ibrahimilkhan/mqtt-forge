using MqttForge.Application.Alerts;

namespace MqttForge.UnitTests.Application.Alerts;

public class PayloadValueTests
{
    // One body carrying every shape a rule can be pointed at: a number, a string, a boolean, a
    // null, a number written as a string, a key that begins with a dollar, an array of objects,
    // and a nest deep enough to walk off the end of.
    private const string Body = """
        {"temp":23.5,"unit":"C","ok":true,"error":null,"reading":"12.5","$temp":1,
         "radios":[{"crc":3},{"crc":9}],
         "a":{"b":{"c":{"d":{"e":{"f":6,"g":{"h":7}}}}}}}
        """;

    [Fact]
    public void A_field_that_was_not_asked_for_is_the_body_itself()
    {
        Assert.True(PayloadValue.TryExtract("23.5", null, out var text));
        Assert.Equal("23.5", text);
    }

    [Fact]
    public void An_empty_field_is_the_body_itself()
    {
        Assert.True(PayloadValue.TryExtract("23.5", "", out var text));
        Assert.Equal("23.5", text);
    }

    [Fact]
    public void A_body_that_is_not_json_is_still_the_body_when_no_field_was_asked_for()
    {
        // A pattern rule over a topic that says 'warming up' has to see those words. Only a
        // field turns the body into a document that has to parse.
        Assert.True(PayloadValue.TryExtract("warming up", null, out var text));
        Assert.Equal("warming up", text);
    }

    [Theory]
    [InlineData("temp", "23.5")]
    [InlineData("$.temp", "23.5")]
    [InlineData("unit", "C")]
    [InlineData("ok", "true")]
    [InlineData("error", "null")]
    [InlineData("reading", "12.5")]
    [InlineData("$temp", "1")]
    [InlineData("radios[1].crc", "9")]
    [InlineData("radios.1.crc", "9")]
    [InlineData("$.radios[0].crc", "3")]
    [InlineData("a.b.c.d.e.f", "6")]
    public void A_path_that_is_there_comes_back_as_text(string field, string expected)
    {
        Assert.True(PayloadValue.TryExtract(Body, field, out var text));
        Assert.Equal(expected, text);
    }

    [Fact]
    public void A_string_leaf_comes_back_without_its_quotes()
    {
        // The words the device wrote, not the punctuation JSON put around them: a pattern rule
        // reading 'unit' should be written '^C$' and not '^"C"$'.
        Assert.True(PayloadValue.TryExtract(Body, "unit", out var text));
        Assert.Equal("C", text);
    }

    [Fact]
    public void A_number_written_as_a_string_is_still_read_as_a_reading()
    {
        // Plenty of devices quote their numbers. The console charts them — asReading works on
        // the text, not on the JSON type — so a threshold rule has to as well.
        Assert.True(PayloadValue.TryExtract(Body, "reading", out var text));
        Assert.Equal<double?>(12.5, PayloadValue.AsReading(text));
    }

    [Fact]
    public void A_json_null_is_found_and_is_not_a_number()
    {
        // Present and null is not absent. The topic answered; the answer was 'null'. A numeric
        // condition then skips it because the text is not a reading, which is the same outcome a
        // missing field gets — but by the honest route, and a pattern rule can still see it.
        Assert.True(PayloadValue.TryExtract(Body, "error", out var text));
        Assert.Equal("null", text);
        Assert.Null(PayloadValue.AsReading(text));
    }

    [Fact]
    public void A_boolean_is_found_and_is_not_a_number()
    {
        Assert.True(PayloadValue.TryExtract(Body, "ok", out var text));
        Assert.Equal("true", text);
        Assert.Null(PayloadValue.AsReading(text));
    }

    [Fact]
    public void A_path_that_stops_on_a_subtree_hands_back_that_subtree_as_json()
    {
        Assert.True(PayloadValue.TryExtract(Body, "radios[0]", out var text));
        Assert.Equal("""{"crc":3}""", text);
        Assert.Null(PayloadValue.AsReading(text));
    }

    [Fact]
    public void A_name_beginning_with_a_dollar_is_a_name_and_not_the_document()
    {
        // '$' is only the document when the path goes on with '.' or '['. Stripping it always
        // would make a rule over a field genuinely called '$temp' read a different field.
        Assert.True(PayloadValue.TryExtract(Body, "$temp", out var text));
        Assert.Equal("1", text);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("temp.deeper")]
    [InlineData("radios[2].crc")]
    [InlineData("radios[-1]")]
    [InlineData("radios[]")]
    [InlineData("radios[0")]
    [InlineData("a..b")]
    [InlineData("a.")]
    public void A_path_the_body_does_not_answer_is_not_extracted(string field)
    {
        Assert.False(PayloadValue.TryExtract(Body, field, out var text));
        Assert.Null(text);
    }

    [Fact]
    public void Six_levels_are_walked_and_a_seventh_is_not()
    {
        // The chart's own ceiling. numericFields() never offers a seventh level, so a rule that
        // could read one would be a rule pointed at a field the console cannot show it.
        Assert.True(PayloadValue.TryExtract(Body, "a.b.c.d.e.f", out var sixth));
        Assert.Equal("6", sixth);

        Assert.False(PayloadValue.TryExtract(Body, "a.b.c.d.e.g.h", out _));
    }

    [Fact]
    public void A_path_far_past_the_ceiling_stops_at_the_ceiling()
    {
        // The hostile shape: a nest and a path long enough to walk it. The depth counter stops
        // after the sixth lookup, so the cost of a silly path is bounded by the ceiling and not
        // by the length of the path or the depth of the body.
        Assert.False(PayloadValue.TryExtract("[[[[[[[[1]]]]]]]]", "[0][0][0][0][0][0][0]", out _));
    }

    [Theory]
    [InlineData("23.5")]
    [InlineData("warming up")]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("{ not json")]
    [InlineData("""{"temp": }""")]
    public void A_body_that_is_not_a_document_answers_no_path(string payload)
    {
        Assert.False(PayloadValue.TryExtract(payload, "temp", out var text));
        Assert.Null(text);
    }

    [Fact]
    public void A_document_padded_with_whitespace_is_still_a_document()
    {
        Assert.True(PayloadValue.TryExtract("""  {"temp":1}  """, "temp", out var text));
        Assert.Equal("1", text);
    }

    [Theory]
    [InlineData("[1]", "20")]
    [InlineData("1", "20")]
    public void A_body_that_is_an_array_is_indexed_from_the_top(string field, string expected)
    {
        Assert.True(PayloadValue.TryExtract("[10,20]", field, out var text));
        Assert.Equal(expected, text);
    }

    [Theory]
    [InlineData("23.5", 23.5)]
    [InlineData("-0.5", -0.5)]
    [InlineData("+5", 5d)]
    [InlineData(".5", 0.5)]
    [InlineData("5.", 5d)]
    [InlineData("0", 0d)]
    [InlineData("1e3", 1000d)]
    [InlineData("1E-3", 0.001)]
    [InlineData(" 23.5 ", 23.5)]
    [InlineData("23.5\n", 23.5)]
    [InlineData("1e308", 1e308)]
    public void Text_that_is_a_number_and_nothing_else_is_a_reading(string text, double expected)
    {
        Assert.Equal<double?>(expected, PayloadValue.AsReading(text));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("0x10")]
    [InlineData("NaN")]
    [InlineData("Infinity")]
    [InlineData("-Infinity")]
    [InlineData("12.5C")]
    [InlineData("1,5")]
    [InlineData("1 2")]
    [InlineData("true")]
    [InlineData("null")]
    [InlineData("٢٣")]
    [InlineData("1e999")]
    public void Text_that_is_not_only_a_number_is_not_a_reading(string? text)
    {
        Assert.Null(PayloadValue.AsReading(text));
    }

    [Fact]
    public void A_magnitude_a_double_cannot_hold_is_not_a_reading()
    {
        // '1e999' is digits and an exponent, so the pattern is happy with it and the browser's
        // Number() answers Infinity. A threshold rule fed an infinity fires on a value that never
        // crossed the wire, and never stops firing.
        Assert.Null(PayloadValue.AsReading("1e999"));
        Assert.Null(PayloadValue.AsReading("-1e999"));
    }
}
