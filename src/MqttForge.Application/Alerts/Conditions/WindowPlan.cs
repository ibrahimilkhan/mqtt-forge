using MqttForge.Domain.Models;

namespace MqttForge.Application.Alerts.Conditions;

/// <summary>
/// What one rule needs of a pair before the pair exists: how many readings its ring has to hold,
/// which outlier conditions are on its tree, how long a run of refusals means the plant has moved,
/// and whether anything on the tree is held back by the once-a-second statistical quota.
/// </summary>
// Computed once per pair, in Track, and kept on the pair. Not cached per rule id and not
// recomputed per message, and both of those are decisions:
//
//   * Per message would walk the condition tree and allocate a list of outlier conditions fifty
//     times a second for every topic a rule watches.
//   * A cache keyed by rule id would need invalidating on every save, which means a line in
//     SetRules that a later task can forget. The pair already has the right lifetime: everything
//     ConfigHash covers — Filter, Field, Condition, Clear, For — drops the pair when it changes,
//     and every member of this plan is read off Condition and Clear. So the plan and the ring it
//     sized are always the same age, and there is nothing to invalidate.
public sealed record WindowPlan(
    /// How many readings this rule's pairs each keep.
    int Capacity,
    /// Every outlier condition on the tree, fire and clear alike.
    IReadOnlyList<OutlierCondition> Outliers,
    /// Consecutive refused readings that mean the plant has moved rather than misbehaved.
    int NewLevelAfter,
    /// Whether the tree holds a condition the once-a-second statistical quota binds.
    // No writer at this point in the plan: the three conditions it will be true for —
    // distributionShift, shapeChange and pulse — are not in the union yet, and outlier, which is,
    // is deliberately exempt. It is declared here rather than added later so that the engine's
    // arrival path can be written against the finished shape, and so the task that widens the walk
    // to those three changes one method — Walk, below — and nothing else in this file.
    bool Quota)
{
    public static WindowPlan For(AlertRule rule, AlertEngineOptions options)
    {
        var needs = new Needs();

        Walk(rule.Condition, needs);
        if (rule.Clear is not null) Walk(rule.Clear, needs);

        // The largest window anything on the tree asked for, and DefaultWindow when nothing did.
        // The spec's budget is Σ(window × topics), so this number is both what the pair gets and
        // what the ring budget is charged — Track adds exactly this to _readings.
        var capacity = needs.Asked == 0
            ? options.DefaultWindow
            : Math.Clamp(needs.Asked, options.MinWindow, options.MaxWindow);

        // A quarter of the sample, which with the default window is fifty readings and with the
        // smallest permitted window is five. The largest of the rule's outlier conditions decides
        // it: accepting a new level empties the ring for all of them, so the condition with most
        // to say about the run is the one that should have to be sure.
        var newLevelAfter = 0;
        foreach (var outlier in needs.Outliers)
            newLevelAfter = Math.Max(newLevelAfter, Math.Max(1, Outlier.SampleOf(outlier, capacity) / 4));

        return new WindowPlan(capacity, needs.Outliers, newLevelAfter, needs.Quota);
    }

    /// <summary>What the walk collects. Auto-properties, so an unwritten one is not CS0649.</summary>
    private sealed class Needs
    {
        public int Asked { get; set; }
        public bool Quota { get; set; }
        public List<OutlierCondition> Outliers { get; } = [];
    }

    /// <summary>
    /// The tree, once. Only the composites recurse; the value conditions read the message in hand
    /// and ask for no history at all, which is what keeps a plain threshold rule the cheap thing
    /// it has always been.
    /// </summary>
    // Two different things are being collected here. Every condition that reads the ring
    // contributes its window, because the ring has to be big enough for all of them and the budget
    // has to be charged for the biggest. Only three of them set Quota, because outlier is exempt
    // from the once-a-second ceiling: it is a question about the reading in hand, and a reading
    // nobody looked at is a reading that entered the ring unexamined and moved the fence.
    //
    // Quota is filled here and read nowhere yet, and that is worth being straight about rather
    // than leaving for somebody to find. The ceiling itself is enforced in Statistical.MayLook,
    // per pair, at the moment a condition asks to look — which is the only place that can also let
    // two statistical arms of one rule share an instant instead of taking each other's turn. What
    // this flag is, is the walk's own answer to "does this rule hold a quota-bound condition",
    // available without walking the tree a second time; it costs one boolean per pair, and leaving
    // a member of the plan declared and never written would be worse than that.
    //
    // A fourth statistical condition is one case here and one arm in ConditionEvaluator.Evaluate.
    private static void Walk(AlertCondition condition, Needs needs)
    {
        switch (condition)
        {
            case OutlierCondition outlier:
                needs.Outliers.Add(outlier);
                needs.Asked = Math.Max(needs.Asked, outlier.Window);
                break;

            case DistributionShiftCondition shift:
                needs.Quota = true;
                needs.Asked = Math.Max(needs.Asked, shift.Window);
                break;

            case ShapeChangeCondition shape:
                needs.Quota = true;
                needs.Asked = Math.Max(needs.Asked, shape.Window);
                break;

            case PulseCondition pulse:
                needs.Quota = true;
                needs.Asked = Math.Max(needs.Asked, pulse.Window);
                break;

            case AllCondition all:
                foreach (var child in all.Of) Walk(child, needs);
                break;

            case AnyCondition any:
                foreach (var child in any.Of) Walk(child, needs);
                break;
        }
    }
}
