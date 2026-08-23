using MqttForge.Domain.Models;

namespace MqttForge.Domain.Abstractions;

/// <summary>Connections the reader has chosen to keep, by name.</summary>
public interface ISavedProfileStore
{
    Task<IReadOnlyList<SavedBrokerProfile>> ListAsync(CancellationToken ct);

    /// <summary>Adds it, or replaces the one already under that name.</summary>
    Task SaveAsync(SavedBrokerProfile profile, CancellationToken ct);

    /// <summary>False when there was nothing under that name to delete.</summary>
    Task<bool> DeleteAsync(string name, CancellationToken ct);
}
