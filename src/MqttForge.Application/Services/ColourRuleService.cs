using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Services;

/// <summary>
/// The colour rules, read and replaced whole. Nothing is cached: the file holds at most a hundred
/// short records and is read only when a console loads, not on the message path.
/// </summary>
public sealed class ColourRuleService
{
    private readonly IColourRuleStore _store;

    public ColourRuleService(IColourRuleStore store) => _store = store;

    public Task<IReadOnlyList<TopicColourRule>> GetAsync(CancellationToken ct) => _store.LoadAsync(ct);

    public Task ReplaceAsync(IReadOnlyList<TopicColourRule> rules, CancellationToken ct) =>
        _store.SaveAsync(rules, ct);
}
