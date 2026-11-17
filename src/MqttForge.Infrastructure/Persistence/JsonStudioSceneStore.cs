using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;

namespace MqttForge.Infrastructure.Persistence;

// Write mechanics are JsonFlowStore's — a temporary file, then a swap — so an interrupted write
// cannot leave half a scene behind. One file per scene, so a broken one costs that scene and not
// the folder: the list goes on without it, and opening it says why it cannot be opened.
public sealed class JsonStudioSceneStore : IStudioSceneStore
{
    private readonly string _directory;
    private readonly ILogger _log;

    // Two saves of one scene from two consoles would otherwise race on the same .tmp file.
    private readonly SemaphoreSlim _gate = new(1, 1);

    public JsonStudioSceneStore(string studioDirectory, ILogger<JsonStudioSceneStore>? log = null)
    {
        _directory = Path.Combine(studioDirectory, "scenes");
        _log = (ILogger?)log ?? NullLogger.Instance;
    }

    public async Task<IReadOnlyList<StudioSceneSummary>> ListAsync(CancellationToken ct)
    {
        var all = await ReadAllAsync(ct);
        var summaries = new List<StudioSceneSummary>(all.Documents.Count);

        foreach (var document in all.Documents)
            summaries.Add(new StudioSceneSummary(
                document.GetProperty("id").GetString()!,
                document.GetProperty("name").GetString()!,
                document.TryGetProperty("updatedAt", out var at) && at.TryGetDateTimeOffset(out var when)
                    ? when
                    : DateTimeOffset.MinValue));

        return summaries;
    }

    public async Task<JsonElement?> GetAsync(string id, CancellationToken ct)
    {
        var path = PathOf(id);
        if (!File.Exists(path)) return null;

        return await ReadAsync(path, ct)
            ?? throw new StudioSceneUnreadableException(
                $"The scene file {path} could not be read. Repair it or move it aside; a save to this scene would replace it.");
    }

    public async Task SaveAsync(string id, JsonElement document, CancellationToken ct)
    {
        var path = PathOf(id);
        var temp = path + ".tmp";

        await _gate.WaitAsync(ct);
        try
        {
            Directory.CreateDirectory(_directory);
            await using (var stream = File.Create(temp))
                await JsonSerializer.SerializeAsync(stream, document, cancellationToken: ct);

            File.Move(temp, path, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new StudioNotSavedException($"Could not write the scene to {path}: {ex.Message}", ex);
        }
        finally
        {
            _gate.Release();
        }
    }

    public Task<bool> DeleteAsync(string id, CancellationToken ct)
    {
        var path = PathOf(id);
        if (!File.Exists(path)) return Task.FromResult(false);

        try
        {
            File.Delete(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new StudioNotSavedException($"Could not delete the scene {path}: {ex.Message}", ex);
        }

        return Task.FromResult(true);
    }

    public async Task<StudioSceneSet> ReadAllAsync(CancellationToken ct)
    {
        if (!Directory.Exists(_directory)) return new StudioSceneSet([], AnyUnreadable: false);

        var documents = new List<JsonElement>();
        var anyUnreadable = false;

        foreach (var path in Directory.EnumerateFiles(_directory, "*.json"))
        {
            var document = await ReadAsync(path, ct);
            if (document is null)
            {
                anyUnreadable = true;
                _log.LogWarning("The studio scene {Path} could not be read and is left out of the list.", path);
                continue;
            }

            documents.Add(document.Value);
        }

        return new StudioSceneSet(documents, anyUnreadable);
    }

    // Null for a file that does not parse, or parses into something that is not a scene this store
    // wrote: an object with a string id matching its own file name and a string name.
    private static async Task<JsonElement?> ReadAsync(string path, CancellationToken ct)
    {
        try
        {
            await using var stream = File.OpenRead(path);
            using var parsed = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
            var root = parsed.RootElement;

            var whole = root.ValueKind == JsonValueKind.Object
                && root.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String
                && id.GetString() == Path.GetFileNameWithoutExtension(path)
                && root.TryGetProperty("name", out var name) && name.ValueKind == JsonValueKind.String;

            return whole ? root.Clone() : null;
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private string PathOf(string id) =>
        StudioIds.IsSceneId(id)
            ? Path.Combine(_directory, id + ".json")
            : throw new ArgumentException($"'{id}' is not a scene id.", nameof(id));
}
