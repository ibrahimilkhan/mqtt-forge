using System.Text.Json;
using System.Text.Json.Serialization;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;

namespace MqttForge.Infrastructure.Persistence;

public sealed class JsonConnectionSettingsStore : IConnectionSettingsStore
{
    // Enums written as names. The file is a thing people open when a connection will not come
    // back — "transport": "webSocket" answers a question there that a 1 only raises. Numbers are
    // still read, so a file written before this change still loads.
    private static readonly JsonSerializerOptions Format = new()
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
        WriteIndented = true
    };

    private readonly string _filePath;

    public JsonConnectionSettingsStore(string filePath) => _filePath = filePath;

    // Corrupt/unreadable file is treated as no saved settings (settings are just a cache)
    public async Task<BrokerConnectionSettings?> LoadAsync(CancellationToken ct)
    {
        if (!File.Exists(_filePath)) return null;

        try
        {
            await using var stream = File.OpenRead(_filePath);
            return await JsonSerializer.DeserializeAsync<BrokerConnectionSettings>(stream, Format, ct);
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    // Writes to a temp file then swaps in, so an interrupted write can't corrupt the existing file
    public async Task SaveAsync(BrokerConnectionSettings settings, CancellationToken ct)
    {
        var directory = Path.GetDirectoryName(_filePath);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

        var tempPath = _filePath + ".tmp";
        await using (var stream = File.Create(tempPath))
        {
            await JsonSerializer.SerializeAsync(stream, settings, Format, ct);
        }

        File.Move(tempPath, _filePath, overwrite: true);
    }
}
