using System.Text.Json;
using MQFaker.Domain.Abstractions;
using MQFaker.Domain.Models;

namespace MQFaker.Infrastructure.Persistence;

public sealed class JsonConnectionSettingsStore : IConnectionSettingsStore
{
    private readonly string _filePath;

    public JsonConnectionSettingsStore(string filePath) => _filePath = filePath;

    public async Task<BrokerConnectionSettings?> LoadAsync(CancellationToken ct)
    {
        if (!File.Exists(_filePath)) return null;

        await using var stream = File.OpenRead(_filePath);
        return await JsonSerializer.DeserializeAsync<BrokerConnectionSettings>(stream, cancellationToken: ct);
    }

    public async Task SaveAsync(BrokerConnectionSettings settings, CancellationToken ct)
    {
        var directory = Path.GetDirectoryName(_filePath);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

        await using var stream = File.Create(_filePath);
        await JsonSerializer.SerializeAsync(stream, settings, cancellationToken: ct);
    }
}
