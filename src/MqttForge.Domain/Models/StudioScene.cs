using System.Text.Json;
using System.Text.RegularExpressions;

namespace MqttForge.Domain.Models;

/// <summary>What the scene list shows: enough to pick one without reading every file whole.</summary>
public sealed record StudioSceneSummary(string Id, string Name, DateTimeOffset UpdatedAt);

/// <summary>
/// Every scene that could be read, and whether any could not. The second half is what keeps model
/// collection honest: a scene that cannot be read still owns its models, and nobody can say which.
/// </summary>
public sealed record StudioSceneSet(IReadOnlyList<JsonElement> Documents, bool AnyUnreadable);

/// <summary>
/// The two names the studio turns into file names. Both are checked here, once, because both arrive
/// from a URL — and a scene id of <c>../connection-settings</c> would otherwise be a path.
/// </summary>
public static partial class StudioIds
{
    /// <summary>The model formats the studio stores. Phase 1 stores them; Phase 2 learns to draw them.</summary>
    public static readonly IReadOnlySet<string> ModelExtensions =
        new HashSet<string>(StringComparer.Ordinal) { ".glb", ".gltf", ".stl", ".obj", ".dbmesh", ".step", ".stp", ".iges", ".igs" };

    public static bool IsSceneId(string? id) => id is not null && SceneId().IsMatch(id);

    // The key is the file's SHA-256 and its extension, so it says what the file is and nothing a
    // caller could steer: no separators, no dots before the extension.
    public static bool IsModelKey(string? key) =>
        key is not null && ModelKey().IsMatch(key) && ModelExtensions.Contains(Path.GetExtension(key));

    public static bool IsModelExtension(string? extension) =>
        extension is not null && ModelExtensions.Contains(extension);

    [GeneratedRegex("^[A-Za-z0-9_-]{1,64}$")]
    private static partial Regex SceneId();

    [GeneratedRegex("^[0-9a-f]{64}\\.[a-z]{3,6}$")]
    private static partial Regex ModelKey();
}
