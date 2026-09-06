using MqttForge.Domain;

namespace MqttForge.UnitTests.Domain;

public class TopicFilterCoverTests
{
    [Theory]
    [InlineData("#", "#")]
    [InlineData("#", "plant/#")]
    [InlineData("#", "plant/boiler/temp")]
    [InlineData("#", "+/boiler/+")]
    [InlineData("plant/#", "plant/#")]
    [InlineData("plant/#", "plant/boiler/temp")]
    [InlineData("plant/#", "plant/+/temp")]
    [InlineData("plant/#", "plant")]
    [InlineData("plant/+/temp", "plant/boiler/temp")]
    [InlineData("plant/+/temp", "plant/+/temp")]
    [InlineData("+/+", "a/b")]
    [InlineData("a/b/c", "a/b/c")]
    [InlineData("a/+/b", "a//b")]
    public void A_filter_covers_what_it_would_bring_in_anyway(string wide, string narrow)
    {
        Assert.True(TopicFilterCover.Covers(wide, narrow));
    }

    [Theory]
    // The narrow one reaches deeper, or wider, than the wide one can follow.
    [InlineData("plant/+", "plant/#")]
    [InlineData("plant/+/temp", "plant/#")]
    [InlineData("a/b/c", "a/+/c")]
    [InlineData("a/b/c", "a/b/#")]
    [InlineData("plant/#", "lab/#")]
    [InlineData("plant/boiler", "plant/boiler/temp")]
    [InlineData("plant/boiler/temp", "plant/boiler")]
    [InlineData("+", "a/b")]
    // A wildcard at the head cannot reach the broker's own tree, which is why the console asks
    // for it separately. If '#' were read as covering it, ticking 'include $SYS' would subscribe
    // nothing and the statistics would never arrive.
    [InlineData("#", "$SYS/#")]
    [InlineData("+/#", "$SYS/broker/uptime")]
    // An empty filter is one that was never written. It covers nothing and nothing covers it.
    [InlineData("", "#")]
    [InlineData("#", "")]
    public void And_covers_nothing_else(string wide, string narrow)
    {
        Assert.False(TopicFilterCover.Covers(wide, narrow));
    }

    /// <summary>
    /// The property that makes this safe to subscribe by: whatever a covered filter would have
    /// matched, the filter covering it matches too.
    /// </summary>
    // Written as a walk over topics rather than as a claim, because the whole point of dropping a
    // subscription is that nothing stops arriving, and the two functions are separate walks of
    // the same rules that could drift apart.
    [Theory]
    [InlineData("#", "plant/#")]
    [InlineData("plant/#", "plant/+/temp")]
    [InlineData("plant/+/temp", "plant/boiler/temp")]
    [InlineData("+/+", "a/b")]
    public void What_a_covered_filter_would_have_matched_the_covering_one_matches(
        string wide, string narrow)
    {
        string[] topics =
        [
            "plant", "plant/boiler", "plant/boiler/temp", "plant/boiler/temp/raw",
            "plant/oven/temp", "lab/oven/temp", "a", "a/b", "a/b/c", "", "a//b", "$SYS/broker/x",
        ];

        Assert.True(TopicFilterCover.Covers(wide, narrow));

        foreach (var topic in topics)
        {
            if (!TopicFilterMatch.Matches(narrow, topic)) continue;

            Assert.True(
                TopicFilterMatch.Matches(wide, topic),
                $"'{wide}' covers '{narrow}' but does not match '{topic}'");
        }
    }
}
