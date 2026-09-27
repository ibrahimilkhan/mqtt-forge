using MqttForge.Api;
using Xunit;

namespace MqttForge.UnitTests.Api;

/// <summary>
/// Which pages may show the console in a frame: its own, and the ones an operator names — a Home
/// Assistant panel, say — and nothing a typo could turn into more.
/// </summary>
public class FrameAncestorsTests
{
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void With_nothing_named_only_the_consoles_own_page_may_frame_it(string? setting) =>
        Assert.Equal("frame-ancestors 'self'", FrameAncestors.Policy(setting));

    // A space between them as the policy itself writes them, or a comma, which is what a list in an
    // environment variable tends to look like. Named twice is named once.
    [Theory]
    [InlineData("https://homeassistant.local:8123 http://192.168.1.10:8123")]
    [InlineData("https://homeassistant.local:8123, http://192.168.1.10:8123")]
    [InlineData(" https://homeassistant.local:8123,http://192.168.1.10:8123 https://homeassistant.local:8123 'self' ")]
    public void The_pages_named_are_added_to_the_consoles_own(string setting) =>
        Assert.Equal("frame-ancestors 'self' https://homeassistant.local:8123 http://192.168.1.10:8123",
            FrameAncestors.Policy(setting));

    // What the frame-ancestors grammar takes for a page, within reason: a host with or without its
    // scheme, a wildcard below a domain somebody named, any port, a path.
    [Theory]
    [InlineData("homeassistant.local:8123")]
    [InlineData("https://*.example.com")]
    [InlineData("https://ha.example.com:*")]
    [InlineData("https://ha.example.com/lovelace/mqtt")]
    public void A_page_the_grammar_takes_is_taken(string source) =>
        Assert.Equal($"frame-ancestors 'self' {source}", FrameAncestors.Policy(source));

    // Refused at start rather than sent: a directive smuggled in after a semicolon, a keyword that
    // means nothing here, a source that names no host and so lets every site frame the console, a
    // scheme that is no page, a quote or a control.
    [Theory]
    [InlineData("https://ha.example.com; script-src *")]
    [InlineData("'unsafe-inline'")]
    [InlineData("'none'")]
    [InlineData("*")]
    [InlineData("https:")]
    [InlineData("https://*")]
    [InlineData("javascript:")]
    [InlineData("data:alert")]
    [InlineData("https://ha.example.com\"")]
    [InlineData("https://ha.example.com\u0000")]
    public void Anything_else_stops_the_app_starting_and_names_the_setting(string setting)
    {
        var refused = Assert.Throws<InvalidOperationException>(() => FrameAncestors.Policy(setting));

        Assert.Contains(FrameAncestors.Setting, refused.Message);
    }
}
