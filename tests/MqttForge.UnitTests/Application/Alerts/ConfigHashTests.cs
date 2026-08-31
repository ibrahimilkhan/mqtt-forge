using MqttForge.Application.Alerts;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Alerts;

/// <summary>
/// The hash decides how much of a running engine a save throws away, so it has exactly two ways
/// to be wrong and both are expensive. Too eager, and renaming a rule silently resolves the
/// alarm it is ringing, empties its window, and forgets its cooldown. Too lax, and a rule whose
/// threshold the user just moved goes on judging messages by the old one until the process
/// restarts.
///
/// It is also written down, not just held in memory: alert-state.json carries it across a
/// restart so that an alert restored from disk can be checked against the rule it belongs to. So
/// nothing here may lean on string.GetHashCode, which is randomised per process and would make
/// every rule read as changed on every start.
/// </summary>
public class ConfigHashTests
{
    private static AlertRule Rule(
        AlertCondition condition,
        string filter = "plant/+/temp",
        string? field = "$.temp",
        AlertCondition? clear = null,
        int? forSeconds = null) =>
        new("r1", "Boiler temperature", Enabled: true, filter, field, condition, clear,
            forSeconds, Cooldown: 30, AlertSeverity.Critical, [new ScreenAction()]);

    private static readonly AlertCondition TooHot = new ThresholdCondition(ThresholdOp.Gt, 90);

    [Fact]
    public void Of_is_the_same_for_two_equal_rules_that_are_not_the_same_object()
    {
        var one = Rule(new ThresholdCondition(ThresholdOp.Gt, 90));
        var other = Rule(new ThresholdCondition(ThresholdOp.Gt, 90));

        Assert.NotSame(one, other);
        Assert.Equal(ConfigHash.Of(one), ConfigHash.Of(other));
    }

    // Every PUT sends the whole list, so this is not a curiosity: the rule coming back from the
    // browser is never the object the engine is holding, and a hash that noticed that would
    // reset every rule in the file on every save.
    [Fact]
    public void Of_is_the_same_for_a_rule_rebuilt_from_its_own_parts()
    {
        var original = Rule(new AnyCondition([TooHot, new PatternCondition("^fault", false)]));
        var rebuilt = original with
        {
            Condition = new AnyCondition(
            [
                new ThresholdCondition(ThresholdOp.Gt, 90),
                new PatternCondition("^fault", Negate: false),
            ]),
        };

        Assert.Equal(ConfigHash.Of(original), ConfigHash.Of(rebuilt));
    }

    // The one a hash built out of the record's own ToString would get wrong: nothing at the top
    // level changed, and a record's ToString prints a nested list as its type name.
    [Fact]
    public void Of_changes_when_a_nested_condition_value_changes()
    {
        var one = Rule(new AllCondition([TooHot, new PatternCondition("^on$", false)]));
        var other = Rule(new AllCondition(
            [new ThresholdCondition(ThresholdOp.Gt, 91), new PatternCondition("^on$", false)]));

        Assert.NotEqual(ConfigHash.Of(one), ConfigHash.Of(other));
    }

    [Fact]
    public void Of_changes_when_a_condition_two_levels_down_changes()
    {
        var one = Rule(new AllCondition([new AnyCondition([TooHot])]));
        var other = Rule(new AllCondition(
            [new AnyCondition([new ThresholdCondition(ThresholdOp.Gte, 90)])]));

        Assert.NotEqual(ConfigHash.Of(one), ConfigHash.Of(other));
    }

    [Theory]
    [InlineData("plant/+/pressure", "$.temp")]
    [InlineData("plant/+/temp", "$.pressure")]
    [InlineData("plant/+/temp", null)]
    public void Of_changes_with_the_filter_and_the_field(string filter, string? field) =>
        Assert.NotEqual(
            ConfigHash.Of(Rule(TooHot)),
            ConfigHash.Of(Rule(TooHot, filter, field)));

    [Fact]
    public void Of_changes_when_For_changes()
    {
        Assert.NotEqual(
            ConfigHash.Of(Rule(TooHot)),
            ConfigHash.Of(Rule(TooHot, forSeconds: 30)));
        Assert.NotEqual(
            ConfigHash.Of(Rule(TooHot, forSeconds: 30)),
            ConfigHash.Of(Rule(TooHot, forSeconds: 60)));
    }

    [Fact]
    public void Of_changes_when_a_Clear_is_added()
    {
        Assert.NotEqual(
            ConfigHash.Of(Rule(TooHot)),
            ConfigHash.Of(Rule(TooHot, clear: new ThresholdCondition(ThresholdOp.Lt, 80))));
    }

    // The four the spec keeps out by name, in one save that changes all of them at once. This is
    // the ordinary edit — the user is fixing the wording of an alert and turning the sound on —
    // and none of it changes what the rule fires on.
    [Fact]
    public void Of_does_not_change_when_the_name_severity_cooldown_or_actions_change()
    {
        var rule = Rule(TooHot);
        var edited = rule with
        {
            Name = "Boiler is far too hot",
            Severity = AlertSeverity.Info,
            Cooldown = 600,
            Actions =
            [
                new SoundAction(),
                new WebhookAction("https://example.test/hook",
                    new Dictionary<string, string> { ["Authorization"] = "Bearer x" }),
            ],
        };

        Assert.Equal(ConfigHash.Of(rule), ConfigHash.Of(edited));
    }

    // Enabled is out too, and for a different reason than those four: it has an outcome of its
    // own. A rule switched off drops its state as "rule disabled"; if Enabled were hashed the
    // same event would be reported as "rule changed", which is a worse sentence for it.
    [Fact]
    public void Of_does_not_change_when_only_Enabled_changes() =>
        Assert.Equal(
            ConfigHash.Of(Rule(TooHot)),
            ConfigHash.Of(Rule(TooHot) with { Enabled = false }));

    // The separator earns its keep here. Concatenated plainly, filter "plant/a" with field "b"
    // and filter "plant/ab" with no field are the same run of characters — and those are two
    // rules that read entirely different messages.
    [Fact]
    public void Of_tells_apart_two_rules_whose_fields_would_run_together()
    {
        Assert.NotEqual(
            ConfigHash.Of(Rule(TooHot, "plant/a", "b")),
            ConfigHash.Of(Rule(TooHot, "plant/ab", null)));
    }

    // And the length prefix earns its keep here: a list of two values and one value containing
    // the separator are different rules, and a comma-joined hash would call them the same.
    [Fact]
    public void Of_tells_apart_a_list_of_two_values_from_one_value_containing_a_comma()
    {
        Assert.NotEqual(
            ConfigHash.Of(Rule(new OneOfCondition(["on", "off"], Negate: false))),
            ConfigHash.Of(Rule(new OneOfCondition(["on,off"], Negate: false))));
    }

    // Order is not normalised, and that is a decision rather than an omission: `any` and `all`
    // short-circuit, so the order of the arms is the order the work is done in — and one of
    // those arms may be a pattern that costs fifty milliseconds. Reordering is a real edit. The
    // cost of treating it as one is a window and a cooldown, which the rule rebuilds in seconds.
    [Fact]
    public void Of_changes_when_the_arms_of_an_any_are_reordered()
    {
        var slow = new PatternCondition("^fault", Negate: false);

        Assert.NotEqual(
            ConfigHash.Of(Rule(new AnyCondition([TooHot, slow]))),
            ConfigHash.Of(Rule(new AnyCondition([slow, TooHot]))));
    }

    // Degenerate shapes the editor can produce and the validator has no reason to refuse.
    [Fact]
    public void Of_tells_an_all_of_one_from_the_condition_it_wraps() =>
        Assert.NotEqual(
            ConfigHash.Of(Rule(new AllCondition([TooHot]))),
            ConfigHash.Of(Rule(TooHot)));

    [Fact]
    public void Of_tells_an_empty_all_from_an_empty_any() =>
        Assert.NotEqual(
            ConfigHash.Of(Rule(new AllCondition([]))),
            ConfigHash.Of(Rule(new AnyCondition([]))));

    [Fact]
    public void Of_tells_a_silence_of_thirty_from_a_silence_of_thirty_one() =>
        Assert.NotEqual(
            ConfigHash.Of(Rule(new SilenceCondition(30))),
            ConfigHash.Of(Rule(new SilenceCondition(31))));

    [Fact]
    public void Of_tells_a_band_inside_from_the_same_band_outside() =>
        Assert.NotEqual(
            ConfigHash.Of(Rule(new BandCondition(4, 20, Inside: true))),
            ConfigHash.Of(Rule(new BandCondition(4, 20, Inside: false))));

    // Round-trip formatting, not the default. 0.1 + 0.2 is not 0.3, but both print as "0.3" at
    // fifteen digits — so a rule whose threshold really did move would keep judging by the old
    // one. The two thresholds here are the same two doubles a spreadsheet export produces.
    [Fact]
    public void Of_tells_apart_two_thresholds_only_the_round_trip_format_can_separate() =>
        Assert.NotEqual(
            ConfigHash.Of(Rule(new ThresholdCondition(ThresholdOp.Gt, 0.1 + 0.2))),
            ConfigHash.Of(Rule(new ThresholdCondition(ThresholdOp.Gt, 0.3))));

    // The 4-20 mA line the spec keeps coming back to: a rule watching for a transmitter pinned
    // at full scale, and the same rule after somebody widened it by a hundredth.
    [Fact]
    public void Of_tells_apart_a_stuck_line_at_twenty_from_one_at_nineteen_ninety_nine() =>
        Assert.NotEqual(
            ConfigHash.Of(Rule(new ThresholdCondition(ThresholdOp.Gte, 20.0))),
            ConfigHash.Of(Rule(new ThresholdCondition(ThresholdOp.Gte, 19.99))));

    // Written to disk and compared after a restart, so it must be a digest and not a runtime
    // hash code. Randomised string hashing would make every alert restored from alert-state.json
    // resolve as "rule changed" on every single start.
    [Fact]
    public void Of_is_a_stable_digest_rather_than_a_runtime_hash_code()
    {
        var hash = ConfigHash.Of(Rule(TooHot));

        Assert.Equal(64, hash.Length);
        Assert.All(hash, character => Assert.True(char.IsAsciiHexDigitLower(character)));
    }

    // The window is what the engine sizes the ring from, so a user who widens a rule from two
    // hundred readings to two thousand has changed what the rule means. A hash that missed it
    // would leave the rule judging on the old ring until somebody restarted the process.
    [Fact]
    public void Of_notices_a_widened_statistical_window()
    {
        var narrow = Rule(new DistributionShiftCondition(200));
        var wide = Rule(new DistributionShiftCondition(2000));

        Assert.NotEqual(ConfigHash.Of(narrow), ConfigHash.Of(wide));
    }

    // Same k, same window, different method: 1.5 means an IQR multiplier to one of them and one
    // and a half deviations to the other, which are not the same rule at all.
    [Fact]
    public void Of_notices_the_outlier_method_changing_under_the_same_k()
    {
        var tukey = Rule(new OutlierCondition(OutlierMethod.Tukey, 3, 200));
        var sigma = Rule(new OutlierCondition(OutlierMethod.Sigma, 3, 200));

        Assert.NotEqual(ConfigHash.Of(tukey), ConfigHash.Of(sigma));
    }

    // Every field of a pulse rule is part of what it asks. The metric especially: 'period > 8000'
    // and 'width > 8000' share three of their four numbers and mean opposite things.
    [Fact]
    public void Of_notices_every_part_of_a_pulse_rule()
    {
        var period = Rule(new PulseCondition(PulseMetric.Period, ThresholdOp.Gt, 8000, 200));
        var width = Rule(new PulseCondition(PulseMetric.Width, ThresholdOp.Gt, 8000, 200));
        var lower = Rule(new PulseCondition(PulseMetric.Period, ThresholdOp.Gt, 4000, 200));

        Assert.NotEqual(ConfigHash.Of(period), ConfigHash.Of(width));
        Assert.NotEqual(ConfigHash.Of(period), ConfigHash.Of(lower));
    }

    // Two different statistical conditions must never hash alike — the failure the fallback arm
    // was always at risk of, and the reason all four now have arms of their own.
    [Fact]
    public void Of_tells_the_two_edge_conditions_apart()
    {
        Assert.NotEqual(ConfigHash.Of(Rule(new DistributionShiftCondition(200))),
                        ConfigHash.Of(Rule(new ShapeChangeCondition(200))));
    }
}
