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
    public void A_dollar_topic_is_matched_by_a_bare_wildcard()
    {
        // MQTT says a broker should not deliver $SYS to a wildcard subscription, and topicMatch.ts
        // carries no rule about it. Neither does this, and deliberately: this function is asked
        // about messages that have already arrived, so the broker has already had its say. A '$'
        // rule here would make the engine ignore traffic the broker chose to send us, and a
        // silence rule over a filter the log is visibly full of would sit there saying nothing.
        Assert.True(TopicFilterMatch.Matches("#", "$SYS/broker/uptime"));
        Assert.True(TopicFilterMatch.Matches("+/broker/uptime", "$SYS/broker/uptime"));
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
}
