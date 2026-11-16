using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Services;

/// <summary>The 3D Studio's scenes and the model files they point at.</summary>
public sealed class StudioService
{
    /// <summary>
    /// How long an upload nobody names yet is kept. A console uploads a part and saves the scene
    /// naming it a moment later; a collection run from another console's save in between must not
    /// take the part away.
    /// </summary>
    public static readonly TimeSpan UploadGrace = TimeSpan.FromHours(1);

    private readonly IStudioSceneStore _scenes;
    private readonly IStudioModelStore _models;
    private readonly ILogger<StudioService> _log;

    public StudioService(IStudioSceneStore scenes, IStudioModelStore models, ILogger<StudioService> log)
    {
        _scenes = scenes;
        _models = models;
        _log = log;
    }

    public Task<IReadOnlyList<StudioSceneSummary>> ListAsync(CancellationToken ct) => _scenes.ListAsync(ct);

    public Task<JsonElement?> GetAsync(string id, CancellationToken ct) => _scenes.GetAsync(id, ct);

    /// <summary>Keeps the scene, stamped with <paramref name="now"/>, then drops models no scene names.</summary>
    // The server's clock and not the console's: two consoles on two machines sort the list by this.
    public async Task SaveAsync(string id, JsonElement document, DateTimeOffset now, CancellationToken ct)
    {
        var stamped = JsonNode.Parse(document.GetRawText())!.AsObject();
        stamped["updatedAt"] = now.ToString("O");

        await _scenes.SaveAsync(id, JsonSerializer.SerializeToElement(stamped), ct);
        await CollectAsync(ct);
    }

    public async Task<bool> DeleteAsync(string id, CancellationToken ct)
    {
        if (!await _scenes.DeleteAsync(id, ct)) return false;

        await CollectAsync(ct);
        return true;
    }

    public Task<string> PutModelAsync(Stream content, string extension, CancellationToken ct) =>
        _models.PutAsync(content, extension, ct);

    public Stream? OpenModel(string key) => _models.OpenRead(key);

    /// <summary>The model keys a scene document names, read leniently: anything not shaped like one is not one.</summary>
    public static IEnumerable<string> ModelKeys(JsonElement document)
    {
        if (!document.TryGetProperty("objects", out var objects) || objects.ValueKind != JsonValueKind.Array) yield break;

        foreach (var item in objects.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.Object
                && item.TryGetProperty("model", out var model) && model.ValueKind == JsonValueKind.Object
                && model.TryGetProperty("key", out var key) && key.ValueKind == JsonValueKind.String)
                yield return key.GetString()!;
        }
    }

    // A failure here is logged and not thrown: the scene the reader asked to save was saved, and a
    // model file left over until the next save costs disk, not work.
    private async Task CollectAsync(CancellationToken ct)
    {
        var all = await _scenes.ReadAllAsync(ct);
        // A scene that cannot be read still owns models, and which ones cannot be told.
        if (all.AnyUnreadable) return;

        var keep = new HashSet<string>(all.Documents.SelectMany(ModelKeys), StringComparer.Ordinal);
        try
        {
            _models.DeleteUnused(keep, UploadGrace);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.LogWarning(ex, "Unused studio models could not be collected; they will be tried again on the next save.");
        }
    }
}
