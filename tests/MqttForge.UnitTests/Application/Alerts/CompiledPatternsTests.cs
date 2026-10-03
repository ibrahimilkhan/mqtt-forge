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

    // ---- the flows' way: the ordinary engine, with the match timeout on it, for every pattern ----

    // Compile's own tests, at the top of this class, are what say a rule's way is unchanged: the linear engine
    // with no timeout, and the ordinary one with the timeout only for what the linear engine refuses. A flow's
    // way is one for all of them: the ordinary engine and the 50 ms, whether the linear engine would have taken
    // the pattern or not.
    [Theory]
    [InlineData("^ERR-")]
    [InlineData(".*")]
    [InlineData("(a+)+$")]
    [InlineData(@"(a)\1")]
    [InlineData(@"(?=a)b")]
    [InlineData(@"(?<=a)b")]
    public void A_pattern_for_a_flow_uses_the_ordinary_engine_with_the_match_timeout_on_it(string pattern)
    {
        var regex = CompiledPatterns.CompileTimed(pattern);

        Assert.Equal(RegexOptions.None, regex.Options);
        Assert.Equal(TimeSpan.FromMilliseconds(50), regex.MatchTimeout);
    }

    [Fact]
    public void An_unparseable_pattern_for_a_flow_is_thrown_at_whoever_compiles_it()
    {
        Assert.Throws<RegexParseException>(() => CompiledPatterns.CompileTimed("[unterminated"));
    }

    // With a timeout set, the linear engine on .NET 10.0.10 answers no where the answer is yes, and for a flow
    // the answer is what a pattern is for. '.*a[ab]{120}z' is true of a text of 'a's and 'b's that ends in a 'z'
    // when the letter 121 places before the 'z' is an 'a', and of no other: one letter decides it, and the first
    // assertion reads that letter, so that the right answer is not taken from an engine. Of the forty texts of
    // 20,000 that the seeds 1 to 40 make it is true of twenty; the linear engine with a timeout of ten minutes
    // said no to every one of the twenty, where the linear engine without a timeout and the ordinary one are
    // right about all forty. Three of the twenty are here.
    [Theory]
    [InlineData(3u)]
    [InlineData(5u)]
    [InlineData(6u)]
    public void A_pattern_for_a_flow_says_yes_to_a_long_text_it_is_true_of_where_the_linear_engine_with_a_timeout_said_no(uint seed)
    {
        var text = AsAndBs(seed, 20_000) + "z";
        Assert.Equal('a', text[^122]);

        Assert.Matches(CompiledPatterns.CompileTimed(".*a[ab]{120}z"), text);
    }

    /// <summary>A text of 'a's and 'b's from a fixed-seed generator.</summary>
    // Written out here and not taken from Random, as DistributionFitTests writes its own, so that these are the
    // same texts on every machine and every morning: what is asked of them is a particular answer, and a text
    // that came out differently would not ask it.
    private static string AsAndBs(uint seed, int length)
    {
        var state = (ulong)seed;
        var text = new char[length];

        for (var i = 0; i < length; i++)
        {
            // The top bit: the low bits of a generator of this kind only alternate.
            state = (state * 1664525 + 1013904223) % 4294967296;
            text[i] = (state >> 31) == 0 ? 'a' : 'b';
        }

        return new string(text);
    }

    // '(a+)+$' is the textbook runaway pattern, and the linear engine answers it at once, with a no: it is what
    // makes a backtracking shape harmless there. The ordinary engine tries every way of cutting four thousand
    // 'a's into runs before it gives up on the 'b' after them, and checks its timeout as it steps, so it is
    // stopped at the 50 ms. The exception is the assertion; the bound is generous, since a machine that is busy
    // is allowed to be slow.
    [Fact]
    public void A_pattern_that_backtracks_for_ever_gives_up_inside_its_budget_for_a_flow()
    {
        var regex = CompiledPatterns.CompileTimed("(a+)+$");

        var clock = Stopwatch.StartNew();
        Assert.Throws<RegexMatchTimeoutException>(() => regex.IsMatch(HostilePatterns.Payload));
        clock.Stop();

        Assert.True(clock.ElapsedMilliseconds < 2_000, $"took {clock.ElapsedMilliseconds}ms");
    }

    // 'a{9000}.*z' is ten characters, and was nine thousand to the linear engine. The ordinary engine starts the
    // match again at each place in the text and runs to the end of it and back from each, which over 64 KB of
    // 'a's takes it fifteen seconds with no timeout. The exception is the assertion; the bound is generous,
    // since a machine that is busy is allowed to be slow.
    [Fact]
    public void A_pattern_that_is_slow_over_a_long_text_gives_up_inside_its_budget_for_a_flow()
    {
        var regex = CompiledPatterns.CompileTimed("a{9000}.*z");
        var text = new string('a', 65_536);

        var clock = Stopwatch.StartNew();
        Assert.Throws<RegexMatchTimeoutException>(() => regex.IsMatch(text));
        clock.Stop();

        Assert.True(clock.ElapsedMilliseconds < 2_000, $"took {clock.ElapsedMilliseconds}ms");
    }
}
