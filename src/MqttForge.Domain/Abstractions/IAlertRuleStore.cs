using MqttForge.Domain.Models;

namespace MqttForge.Domain.Abstractions;

public interface IAlertRuleStore
{
    /// <summary>Reads the file. Never throws for a file it cannot parse — it says so instead.</summary>
    Task<AlertRuleDocument> LoadAsync(CancellationToken ct);

    /// <summary>Writes the whole list. Throws <c>AlertRulesNotSavedException</c> when it cannot.</summary>
    Task SaveAsync(IReadOnlyList<AlertRule> rules, CancellationToken ct);
}
