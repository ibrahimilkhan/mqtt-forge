using MqttForge.Domain.Models;

namespace MqttForge.Domain.Abstractions;

/// <summary>Connections the reader has chosen to keep, by name.</summary>
public interface ISavedProfileStore
{
    Task<IReadOnlyList<SavedBrokerProfile>> ListAsync(CancellationToken ct);

    /// <summary>
    /// Adds it, or replaces the one it names: by id when it carries one that is here, by name
    /// otherwise. The one replaced keeps its id; a new one is given one. Returns it as stored.
    /// </summary>
    /// <exception cref="InvalidOperationException">
    /// It carries the id of one profile and the name of another — keeping it would leave two
    /// under one name, or quietly delete the other.
    /// </exception>
    Task<SavedBrokerProfile> SaveAsync(SavedBrokerProfile profile, CancellationToken ct);

    /// <summary>False when there was nothing under that name to delete.</summary>
    Task<bool> DeleteAsync(string name, CancellationToken ct);
}
