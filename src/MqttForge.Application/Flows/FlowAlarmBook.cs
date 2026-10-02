using MqttForge.Application.Alerts;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Flows;

/// <summary>Every flow alarm that is up, and the last hundred that went out.</summary>
// An alarm belongs to (flow, alarm node, topic), which is the alert engine's "one alarm per pair,
// not per message" with the node standing in for the rule. The key keeps the flow and node ids
// apart rather than reading them back out of the rule id, because an id may itself hold a '-'
// and "flow-a-b-c" does not say where the flow's id ends.
public sealed class FlowAlarmBook
{
    public const string Cleared = "clear";
    public const string FlowChanged = "flow changed";
    public const string FlowOff = "flow off";
    public const string FlowRemoved = "flow removed";
    public const string ConnectionEnded = AlertEngineCore.ConnectionEnded;

    private readonly Dictionary<Key, Alert> _standing = [];

    // Newest first, like AlertEngineCore's, so the merge in GET /api/alerts has two lists in the
    // same order to interleave.
    private readonly List<Alert> _history = [];

    public static string RuleIdOf(string flowId, string nodeId) => $"flow-{flowId}-{nodeId}";

    /// <summary>
    /// A raise: a new alarm, or one more count on the one already up for this topic. No alarm at
    /// all when a new one would be past <see cref="FlowLimits.StandingAlarms"/>.
    /// </summary>
    public (Alert? Alert, bool IsNew) Raise(
        CompiledFlow flow, AlarmNode node, FlowMessage message, DateTimeOffset now, Random random)
    {
        var key = new Key(flow.Id, node.Id, message.Topic);

        if (_standing.TryGetValue(key, out var standing))
        {
            var counted = standing with { Count = standing.Count + 1, LastSeenAt = now };
            _standing[key] = counted;
            return (counted, false);
        }

        // Only a new alarm waits for a place. One that is already up goes on counting and clears as
        // it always did, and each clear gives a place back.
        if (_standing.Count >= FlowLimits.StandingAlarms) return (null, false);

        var value = PayloadValue.TryExtract(message.Payload, node.ValueField, out var text)
            ? PayloadValue.AsReading(text)
            : null;

        var alert = new Alert(
            // A Guid and not AlertEngineCore's tick-and-counter id: GET /api/alerts merges the two
            // engines' alarms into one list, and a second counter of the same shape could stamp a
            // flow alarm with an id the alert engine has already given one of its own.
            Guid.NewGuid().ToString("N"),
            RuleIdOf(flow.Id, node.Id),
            $"{flow.Name} · {node.Name}",
            message.Topic,
            node.Severity,
            FiredAt: now,
            LastSeenAt: now,
            ResolvedAt: null,
            ResolvedBy: null,
            MutedUntil: null,
            Count: 1,
            node.Reason.Render(message, now, random, FlowLimits.ReasonLength, out _),
            value,
            FlowTemplate.Clip(message.Payload, FlowLimits.SampleLength),
            node.Actions);

        _standing[key] = alert;
        return (alert, true);
    }

    /// <summary>A clear: the alarm up for this topic goes out, or nothing happens.</summary>
    public Alert? Clear(string flowId, string nodeId, string topic, DateTimeOffset now) =>
        _standing.Remove(new Key(flowId, nodeId, topic), out var alert) ? Resolve(alert, Cleared, now) : null;

    /// <summary>Every alarm of one flow, for a flow turned off or taken away.</summary>
    public IReadOnlyList<Alert> ResolveFlow(string flowId, string reason, DateTimeOffset now) =>
        ResolveWhere(key => key.FlowId == flowId, reason, now);

    /// <summary>Every alarm there is, for a link that ended.</summary>
    public IReadOnlyList<Alert> ResolveAll(string reason, DateTimeOffset now) =>
        ResolveWhere(_ => true, reason, now);

    /// <summary>
    /// A flow was redeployed with changes: its alarms stay up only where the alarm still means
    /// what it meant — the same node, the same name, the same level, in a flow of the same name.
    /// </summary>
    // Anything else is a different alarm wearing the old one's key. Keeping a "critical" standing
    // after the node was changed to "info" would leave the rail showing a severity nobody asked for.
    public IReadOnlyList<Alert> Reconcile(CompiledFlow old, CompiledFlow next, DateTimeOffset now) =>
        ResolveWhere(key =>
            key.FlowId == old.Id &&
            !(old.Name == next.Name &&
              old.Nodes.GetValueOrDefault(key.NodeId) is AlarmNode before &&
              next.Nodes.GetValueOrDefault(key.NodeId) is AlarmNode after &&
              before.Name == after.Name && before.Severity == after.Severity),
            FlowChanged, now);

    public IReadOnlyList<Alert> Active() => [.. _standing.Values.OrderBy(alert => alert.FiredAt)];

    public IReadOnlyList<Alert> History() => [.. _history];

    /// <summary>Forgets the alarms that have ended. What is standing is not history.</summary>
    public void ClearHistory() => _history.Clear();

    /// <summary>What is standing, under the Alarm node that holds it up: oldest first, at most <paramref name="most"/> a node.</summary>
    // One pass over every alarm for every node at once. A node with nothing standing is simply not in it.
    public IReadOnlyDictionary<(string FlowId, string NodeId), IReadOnlyList<FlowStanding>> StandingByNode(int most)
    {
        var byNode = new Dictionary<(string FlowId, string NodeId), List<Alert>>();

        foreach (var (key, alert) in _standing)
        {
            if (!byNode.TryGetValue((key.FlowId, key.NodeId), out var alerts))
                byNode[(key.FlowId, key.NodeId)] = alerts = [];

            alerts.Add(alert);
        }

        return byNode.ToDictionary(
            pair => pair.Key,
            IReadOnlyList<FlowStanding> (pair) => [.. pair.Value
                .OrderBy(alert => alert.FiredAt)
                .Take(most)
                .Select(alert => new FlowStanding(alert.Topic, alert.FiredAt, alert.Reason, alert.Count))]);
    }

    private IReadOnlyList<Alert> ResolveWhere(Func<Key, bool> which, string reason, DateTimeOffset now)
    {
        var keys = _standing.Keys.Where(which).ToList();
        if (keys.Count == 0) return [];

        var resolved = new List<Alert>(keys.Count);
        foreach (var key in keys)
            if (_standing.Remove(key, out var alert))
                resolved.Add(Resolve(alert, reason, now));

        return resolved;
    }

    private Alert Resolve(Alert alert, string reason, DateTimeOffset now)
    {
        var done = alert with { ResolvedAt = now, ResolvedBy = reason };

        _history.Insert(0, done);
        if (_history.Count > FlowLimits.AlarmHistory)
            _history.RemoveRange(FlowLimits.AlarmHistory, _history.Count - FlowLimits.AlarmHistory);

        return done;
    }

    private readonly record struct Key(string FlowId, string NodeId, string Topic);
}
