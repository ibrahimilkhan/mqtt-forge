using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Services;

/// <summary>
/// The brokers somebody chose to keep. Nothing is cached: the file holds a handful of short
/// records and is read when a console loads, not on the message path.
/// </summary>
public sealed class SavedProfileService
{
    private readonly ISavedProfileStore _store;

    public SavedProfileService(ISavedProfileStore store) => _store = store;

    public Task<IReadOnlyList<SavedBrokerProfile>> GetAsync(CancellationToken ct) => _store.ListAsync(ct);

    public Task SaveAsync(SavedBrokerProfile profile, CancellationToken ct) => _store.SaveAsync(profile, ct);

    public Task<bool> DeleteAsync(string name, CancellationToken ct) => _store.DeleteAsync(name, ct);
}
