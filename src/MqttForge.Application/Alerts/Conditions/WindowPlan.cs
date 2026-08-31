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
    private static void Walk(AlertCondition condition, Needs needs)
    {
        switch (condition)
        {
            case OutlierCondition outlier:
                needs.Outliers.Add(outlier);
                needs.Asked = Math.Max(needs.Asked, outlier.Window);
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
