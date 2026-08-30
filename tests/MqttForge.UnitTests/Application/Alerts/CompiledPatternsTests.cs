using System.Diagnostics;
using System.Text.RegularExpressions;
using MqttForge.Application.Alerts.Conditions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Alerts;

public class CompiledPatternsTests
{
    [Theory]
    [InlineData("^ERR-")]
    [InlineData(".*")]
    [InlineData("(a+)+$")]
    public void A_pattern_the_linear_engine_can_take_uses_it(string pattern)
    {
        var regex = CompiledPatterns.Compile(pattern);

        Assert.Equal(RegexOptions.NonBacktracking, regex.Options);
        Assert.Equal(Regex.InfiniteMatchTimeout, regex.MatchTimeout);
    }

    [Theory]
    [InlineData(@"(a)\1")]
    [InlineData(@"(?=a)b")]
    [InlineData(@"(?<=a)b")]
    public void A_pattern_the_linear_engine_refuses_falls_back_to_a_timed_regex(string pattern)
    {
        var regex = CompiledPatterns.Compile(pattern);

        Assert.Equal(RegexOptions.None, regex.Options);
        Assert.Equal(TimeSpan.FromMilliseconds(50), regex.MatchTimeout);
    }

    // Identity is the assertion, because 'compiled once' is not something a return value can say.
    // One Regex serves three lookups here: the fire condition, the Clear condition that negates
    // the same text, and a freshly built equal condition — so neither a second rule nor a second
    // message can cause a second compilation.
    [Fact]
    public void A_pattern_is_compiled_once_for_the_rule_set_and_not_per_message()
    {
        var fires = new PatternCondition("^ERR-", Negate: false);
        var clears = new PatternCondition("^ERR-", Negate: true);

        var patterns = CompiledPatterns.For([
            new AlertRule("r1", "errors", true, "plant/#", null, fires, clears, null, null, AlertSeverity.Warn, []),
            new AlertRule("r2", "errors again", true, "line/#", null,
                new AllCondition([new AnyCondition([fires])]), null, null, null, AlertSeverity.Info, [])
        ]);

        var first = patterns[fires];

        Assert.Same(first, patterns[fires]);
        Assert.Same(first, patterns[clears]);
        Assert.Same(first, patterns[new PatternCondition("^ERR-", Negate: false)]);
    }

    [Fact]
    public void Patterns_are_collected_from_every_branch_of_a_composite_and_from_Clear()
    {
        var buried = new PatternCondition("^ERR-", Negate: false);
        var inClear = new PatternCondition("^OK", Negate: false);

        var patterns = CompiledPatterns.For([
            new AlertRule("r1", "deep", true, "plant/#", null,
                new AllCondition([new ThresholdCondition(ThresholdOp.Gt, 1), new AnyCondition([buried])]),
                inClear, null, null, AlertSeverity.Warn, [])
        ]);

        Assert.NotNull(patterns[buried]);
        Assert.NotNull(patterns[inClear]);
    }

    // The message path must never compile. A pattern that reaches it uncompiled is a wiring bug,
    // and answering it by compiling on the spot would be the per-message compilation this class
    // exists to prevent — quietly, and only under the load that makes it expensive. Throwing puts
    // it in the engine's per-pair try/catch instead, which marks the rule Faulted and says so in
    // the panel.
    [Fact]
    public void A_pattern_that_was_not_in_the_rule_set_is_not_compiled_on_the_message_path()
    {
        var patterns = CompiledPatterns.For([]);

        Assert.Throws<KeyNotFoundException>(() => patterns[new PatternCondition("^ERR-", Negate: false)]);
    }

    // Nothing here rescues an unparseable pattern: the validator refuses it on the way in and
    // JsonAlertRuleStore compiles on load so a hand-edited file is caught there. Both call this.
    [Fact]
    public void An_unparseable_pattern_is_thrown_at_whoever_compiles_it()
    {
        Assert.Throws<RegexParseException>(() => CompiledPatterns.Compile("[unterminated"));
    }

    [Fact]
    public void The_fallback_engine_gives_up_on_a_catastrophic_pattern_inside_its_budget()
    {
        var regex = CompiledPatterns.Compile(HostilePatterns.Catastrophic);

        var clock = Stopwatch.StartNew();
        Assert.Throws<RegexMatchTimeoutException>(() => regex.IsMatch(HostilePatterns.Payload));
        clock.Stop();

        // Ten times the 50ms budget. The number being asserted is 'it stopped', not 'it stopped
        // in exactly 50ms' — a loaded machine is allowed to be slow, an unbounded one is not.
        Assert.True(clock.ElapsedMilliseconds < 500, $"took {clock.ElapsedMilliseconds}ms");
    }
}
