using MqttForge.Domain;

namespace MqttForge.UnitTests.Domain;

public class TopicFilterMatchTests
{
    [Theory]
    [InlineData("sensors/room/temp", "sensors/room/temp")]
    [InlineData("sensors/+/temp", "sensors/room/temp")]
    [InlineData("+/+/+", "a/b/c")]
    [InlineData("+", "a")]
    [InlineData("sensors/#", "sensors/room/temp")]
    [InlineData("sensors/#", "sensors/room/temp/raw")]
    [InlineData("#", "sensors/room/temp")]
    [InlineData("#", "")]
    [InlineData("a//b", "a//b")]
    [InlineData("a/+/b", "a//b")]
    [InlineData("sensors/", "sensors/")]
    public void A_filter_matches_the_topics_it_covers(string filter, string topic)
    {
        Assert.True(TopicFilterMatch.Matches(filter, topic));
    }

    [Theory]
    [InlineData("sensors/room/temp", "sensors/hall/temp")]
    [InlineData("sensors/+", "sensors/room/temp")]
    [InlineData("sensors/+", "sensors")]
    [InlineData("+", "a/b")]
    [InlineData("sensors/room/temp", "sensors/room")]
    [InlineData("sensors/room/temp", "sensors/room/temp/raw")]
    [InlineData("sensors/#", "actuators/valve")]
    [InlineData("sensors/", "sensors")]
    [InlineData("sensors", "sensors/")]
    public void A_filter_does_not_match_the_topics_it_does_not_cover(string filter, string topic)
    {
        Assert.False(TopicFilterMatch.Matches(filter, topic));
    }

    [Fact]
    public void A_hash_covers_the_level_it_hangs_off_as_mqtt_does()
    {
        // 'sensors/#' is a subscription to sensors and everything beneath it, and the tree's own
        // treeFilter() builds exactly this shape from a node's path. A rule written off the tree
        // has to fire on the node it was written from.
        Assert.True(TopicFilterMatch.Matches("sensors/#", "sensors"));
        Assert.True(TopicFilterMatch.Matches("sensors/room/temp/#", "sensors/room/temp"));
    }

    [Fact]
    public void An_empty_filter_matches_nothing()
    {
        Assert.False(TopicFilterMatch.Matches("", "sensors"));
        Assert.False(TopicFilterMatch.Matches("", ""));
    }

    [Fact]
    public void A_dollar_topic_is_not_matched_by_a_filter_that_opens_with_a_wildcard()
    {
        // This used to answer true, on the grounds that the function is asked about messages that
        // have already arrived and the broker has therefore already had its say about them. The
        // broker's say is per subscription, and the engine does not have one per rule: every rule
        // and the console itself share a connection, so what arrives under the console's own
        // '$SYS/#' is offered to every rule there is. Tick Subscribe $SYS — a box in the Broker
        // panel, not a filter somebody had to type — and a rule reading '+/broker/#' was handed
        // twenty-nine of the broker's statistics and stood an alarm on each of them.
        //
        // A rule that names the tree still reaches it, which is the case the old note was
        // protecting: only a filter that opens with a wildcard is turned away, exactly as a broker
        // turns one away. TopicFilterCover has always said so; these two now agree with it.
        Assert.False(TopicFilterMatch.Matches("#", "$SYS/broker/uptime"));
        Assert.False(TopicFilterMatch.Matches("+/broker/uptime", "$SYS/broker/uptime"));
        Assert.True(TopicFilterMatch.Matches("$SYS/#", "$SYS/broker/uptime"));
        Assert.True(TopicFilterMatch.Matches("$SYS/+/uptime", "$SYS/broker/uptime"));
        // The rule is about the first level only: a '$' deeper in a topic is an ordinary segment.
        Assert.True(TopicFilterMatch.Matches("#", "plant/$odd/temp"));
    }

    [Fact]
    public void A_hash_that_is_not_the_last_segment_still_swallows_the_rest()
    {
        // Not a filter anyone can save — Api/Validation/TopicFilter.cs refuses it — but the
        // browser answers true here and so does this, because the two must not disagree about
        // any input at all. Keeping them identical is cheaper than keeping a second rule about
        // which inputs the identity holds for.
        Assert.True(TopicFilterMatch.Matches("a/#/b", "a/x/b"));
    }

    [Theory]
    [InlineData("sensors/+/temp", true)]
    [InlineData("sensors/#", true)]
    [InlineData("#", true)]
    [InlineData("+", true)]
    [InlineData("sensors/room/temp", false)]
    [InlineData("", false)]
    public void HasWildcard_says_whether_a_filter_names_one_topic_or_many(string filter, bool expected)
    {
        Assert.Equal(expected, TopicFilterMatch.HasWildcard(filter));
    }

    // Moved here from Api so the flow compiler, which lives in Application, can ask it too.
    [Theory]
    [InlineData("plant/+/temp", true)]
    [InlineData("plant/#", true)]
    [InlineData("#", true)]
    [InlineData("a//b", true)]
    [InlineData("", false)]
    [InlineData(null, false)]
    [InlineData("plant/#/temp", false)]
    [InlineData("plant/te+mp", false)]
    [InlineData("plant/te#", false)]
    [InlineData("plant/\0", false)]
    public void IsValidFilter_answers_what_the_api_validator_always_answered(string? filter, bool valid) =>
        Assert.Equal(valid, TopicFilterMatch.IsValidFilter(filter));

    // One sentence for every way a filter can be wrong. Seen live: plant/#/temp was answered with
    // "Write a topic filter", to somebody who had written one and needed to hear where '#' may go.
    [Theory]
    [InlineData("", "Write a topic filter, like plant/+/temp.")]
    [InlineData(null, "Write a topic filter, like plant/+/temp.")]
    [InlineData("plant/#/temp", "'#' can only be the last level. For one level in the middle, use '+', as in plant/+/temp.")]
    [InlineData("plant/te#", "'#' has to be a level of its own, as in plant/#.")]
    [InlineData("plant/te+mp", "'+' has to be a level of its own, as in plant/+/temp.")]
    [InlineData("plant/\0", "A topic filter cannot contain a NUL character.")]
    public void FilterProblem_says_what_is_wrong_with_a_filter(string? filter, string problem) =>
        Assert.Equal(problem, TopicFilterMatch.FilterProblem(filter));

    [Theory]
    [InlineData("plant/+/temp")]
    [InlineData("plant/#")]
    [InlineData("#")]
    [InlineData("a//b")]
    public void FilterProblem_finds_nothing_wrong_with_a_well_formed_filter(string filter) =>
        Assert.Null(TopicFilterMatch.FilterProblem(filter));

    // A string on the wire carries its length in two bytes, and they count UTF-8 bytes, not
    // characters: 32,768 of 'ü' is 65,536 of them.
    [Fact]
    public void FilterProblem_holds_a_filter_to_the_65535_bytes_MQTT_can_carry()
    {
        const string tooLong = "MQTT allows a topic filter of at most 65,535 bytes.";

        Assert.Null(TopicFilterMatch.FilterProblem(new string('a', 65_535)));
        Assert.Equal(tooLong, TopicFilterMatch.FilterProblem(new string('a', 65_536)));
        Assert.Equal(tooLong, TopicFilterMatch.FilterProblem(new string('ü', 32_768)));
        Assert.False(TopicFilterMatch.IsValidFilter(new string('a', 65_536)));
    }
}
