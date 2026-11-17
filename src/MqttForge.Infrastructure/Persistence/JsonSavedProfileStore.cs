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
    //
    // A profile from a file written before ids is given one here, and the file written back with
    // it — once, under the gate, so two consoles loading at the same moment cannot each mint a
    // different id for the same broker and leave a rule holding the one that lost. A write that
    // fails is not an error to the reader, who asked only for the list: the ids go out unkept and
    // are minted again next time, and a rule pointed at one in between loses its broker. That
    // takes a file that could be read and not written back, in the same moment.
    public async Task<IReadOnlyList<SavedBrokerProfile>> ListAsync(CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var (profiles, minted) = await ReadAsync(ct);

            if (minted)
            {
                try
                {
                    await WriteAsync(profiles, ct);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                }
            }

            return profiles;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<SavedBrokerProfile> SaveAsync(SavedBrokerProfile profile, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var (profiles, _) = await ReadAsync(ct);
            var byName = profiles.FindIndex(one => Same(one.Name, profile.Name));
            var byId = profile.Id is { } id ? profiles.FindIndex(one => one.Id == id) : -1;

            // The id, when it is one of ours, says which profile this is — so a new name on it is
            // that profile renamed. The name it is renamed to may not be another's.
            if (byId >= 0 && byName >= 0 && byName != byId)
                throw new InvalidOperationException($"There is already a saved broker named '{profiles[byName].Name}'.");

            var at = byId >= 0 ? byId : byName;
            var kept = profile with { Id = at >= 0 ? profiles[at].Id : SavedBrokerProfile.NewId() };

            // Replaced in place rather than moved to the end: a list that reordered itself every
            // time somebody corrected a port would make the chips move under the hand that is
            // correcting them.
            if (at >= 0) profiles[at] = kept;
            else profiles.Add(kept);

            await WriteAsync(profiles, ct);

            return kept;
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
            var (profiles, _) = await ReadAsync(ct);
            if (profiles.RemoveAll(one => Same(one.Name, name)) == 0) return false;

            await WriteAsync(profiles, ct);
            return true;
        }
        finally
        {
            _gate.Release();
        }
    }

    // The file as it stands, every profile in it with an id, and whether any had to be given one.
    // Callers hold the gate.
    private async Task<(List<SavedBrokerProfile> Profiles, bool Minted)> ReadAsync(CancellationToken ct)
    {
        if (!File.Exists(_filePath)) return ([], false);

        List<SavedBrokerProfile>? profiles;
        try
        {
            await using var stream = File.OpenRead(_filePath);
            profiles = await JsonSerializer.DeserializeAsync<List<SavedBrokerProfile>>(stream, Format, ct);
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            return ([], false);
        }

        // A file holding 'null' parses but carries no list.
        if (profiles is null) return ([], false);

        var minted = false;
        for (var at = 0; at < profiles.Count; at++)
        {
            if (!string.IsNullOrEmpty(profiles[at].Id)) continue;

            profiles[at] = profiles[at] with { Id = SavedBrokerProfile.NewId() };
            minted = true;
        }

        return (profiles, minted);
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
