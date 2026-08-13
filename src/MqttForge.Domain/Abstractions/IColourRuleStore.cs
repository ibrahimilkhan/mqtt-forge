using MqttForge.Domain.Models;

namespace MqttForge.Domain.Abstractions;

// Persists the colour rules across restarts. Absent is not an error: no rules is a valid state.
public interface IColourRuleStore
{
    Task<IReadOnlyList<TopicColourRule>> LoadAsync(CancellationToken ct);
    Task SaveAsync(IReadOnlyList<TopicColourRule> rules, CancellationToken ct);
}
