using System.Text.Json;
using System.Text.Json.Serialization;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;

namespace MqttForge.Infrastructure.Persistence;

public sealed class JsonSavedProfileStore : ISavedProfileStore
{
    // Enums as names, matching the connection settings file next to it: these are files people
    // open when a connection will not come back, and "transport": "webSocket" answers a question
    // there that a 1 only raises.
    private static readonly JsonSerializerOptions Format = new()
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
        WriteIndented = true
    };

    private readonly string _filePath;

    // One writer at a time. Save and Delete are both read-modify-write over the whole list, and
    // two of them at once would lose one of the two edits.
    private readonly SemaphoreSlim _gate = new(1, 1);

    public JsonSavedProfileStore(string filePath) => _filePath = filePath;

    // A file nobody can read is treated as no profiles. Unlike the connection settings, losing
    // these loses something the reader typed on purpose — so it is not silently overwritten
    // either: the next Save writes the list as it stands, which is the empty one, and that is
    // the same outcome as a missing file. Nothing here can recover a corrupt one.
    public async Task<IReadOnlyList<SavedBrokerProfile>> ListAsync(CancellationToken ct)
    {
        if (!File.Exists(_filePath)) return [];

        try
        {
            await using var stream = File.OpenRead(_filePath);
            var profiles = await JsonSerializer
                .DeserializeAsync<List<SavedBrokerProfile>>(stream, Format, ct);

            // A file holding 'null' parses but carries no list.
            return profiles ?? [];
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }

    public async Task SaveAsync(SavedBrokerProfile profile, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var profiles = (await ListAsync(ct)).ToList();
            var at = profiles.FindIndex(one => Same(one.Name, profile.Name));

            // Replaced in place rather than moved to the end: a list that reordered itself every
            // time somebody corrected a port would make the chips move under the hand that is
            // correcting them.
            if (at >= 0) profiles[at] = profile;
            else profiles.Add(profile);

            await WriteAsync(profiles, ct);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<bool> DeleteAsync(string name, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var profiles = (await ListAsync(ct)).ToList();
            if (profiles.RemoveAll(one => Same(one.Name, name)) == 0) return false;

            await WriteAsync(profiles, ct);
            return true;
        }
        finally
        {
            _gate.Release();
        }
    }

    // Case-insensitively, because a name is a label rather than a key: somebody who saved
    // "Lab broker" and then types "lab broker" means the one they already have.
    private static bool Same(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

    // Writes to a temp file then swaps in, so an interrupted write cannot corrupt the existing
    // one. The same discipline as the two stores beside it, and it matters more here: this file
    // is the only copy of something the reader typed.
    private async Task WriteAsync(IReadOnlyList<SavedBrokerProfile> profiles, CancellationToken ct)
    {
        var directory = Path.GetDirectoryName(_filePath);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

        var tempPath = _filePath + ".tmp";
        await using (var stream = File.Create(tempPath))
        {
            await JsonSerializer.SerializeAsync(stream, profiles, Format, ct);
        }

        File.Move(tempPath, _filePath, overwrite: true);
    }
}
