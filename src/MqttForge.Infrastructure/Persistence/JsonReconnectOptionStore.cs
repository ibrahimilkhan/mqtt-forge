using System.Text.Json;
using MqttForge.Domain.Abstractions;

namespace MqttForge.Infrastructure.Persistence;

public sealed class JsonReconnectOptionStore : IReconnectOptionStore
{
    private static readonly JsonSerializerOptions Format = new() { WriteIndented = true };

    // A record with one member rather than a bare bool on the wire. The file is a thing people
    // open, and `{ "enabled": false }` answers the question it was opened with, where `false`
    // only raises it — the same reasoning that put enum names in the connection settings file.
    private sealed record Saved(bool Enabled);

    private readonly string _filePath;

    public JsonReconnectOptionStore(string filePath) => _filePath = filePath;

    /// <summary>Null for no file and for an unreadable one, which both mean "the default stands".</summary>
    // Unreadable is deliberately not an error here. This is a preference, not a rule set: the
    // worst a lost one can do is supervise a link somebody had turned supervision off for, and
    // that is visible on the panel and one click from being turned off again. Refusing to start
    // over it would be the more expensive mistake.
    public async Task<bool?> LoadAsync(CancellationToken ct)
    {
        if (!File.Exists(_filePath)) return null;

        try
        {
            await using var stream = File.OpenRead(_filePath);
            var saved = await JsonSerializer.DeserializeAsync<Saved>(stream, Format, ct);

            return saved?.Enabled;
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    // Temp file then swap, so an interrupted write cannot leave a half-file behind — the same
    // dance every other store in this folder does, for the same reason.
    public async Task SaveAsync(bool enabled, CancellationToken ct)
    {
        var directory = Path.GetDirectoryName(_filePath);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

        var tempPath = _filePath + ".tmp";
        await using (var stream = File.Create(tempPath))
        {
            await JsonSerializer.SerializeAsync(stream, new Saved(enabled), Format, ct);
        }

        File.Move(tempPath, _filePath, overwrite: true);
    }
}
