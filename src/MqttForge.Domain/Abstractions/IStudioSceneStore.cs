using System.Text.Json;
using MqttForge.Domain.Models;

namespace MqttForge.Domain.Abstractions;

/// <summary>Where the 3D Studio's scenes are kept: one document per scene, read and written whole.</summary>
// Per scene rather than one file for all of them, for the reason IFlowStore is per flow: a phone and
// a desk editing two different scenes must not have the second save take the first one's work away.
// The document is kept as JSON the server does not interpret beyond its id, name and model keys —
// what a joint or a pose means is the console's business, and a newer console's fields survive an
// older server untouched.
public interface IStudioSceneStore
{
    /// <summary>The readable scenes, newest first is the caller's choice; files that will not parse are left out and logged.</summary>
    Task<IReadOnlyList<StudioSceneSummary>> ListAsync(CancellationToken ct);

    /// <summary>The scene, or null when there is none by that id.</summary>
    /// <exception cref="Exceptions.StudioSceneUnreadableException">The file is there and will not parse.</exception>
    Task<JsonElement?> GetAsync(string id, CancellationToken ct);

    /// <exception cref="Exceptions.StudioNotSavedException">The file could not be written.</exception>
    Task SaveAsync(string id, JsonElement document, CancellationToken ct);

    /// <summary>False when no scene had that id.</summary>
    Task<bool> DeleteAsync(string id, CancellationToken ct);

    Task<StudioSceneSet> ReadAllAsync(CancellationToken ct);
}
