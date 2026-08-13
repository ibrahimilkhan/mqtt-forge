using System.Text.Json;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;

namespace MqttForge.Infrastructure.Persistence;

public sealed class JsonColourRuleStore : IColourRuleStore
{
    private readonly string _filePath;

    public JsonColourRuleStore(string filePath) => _filePath = filePath;

    // Corrupt/unreadable file is treated as no rules: they are a preference, not a record, and a
    // file nobody can read is worth less than a clean start.
    public async Task<IReadOnlyList<TopicColourRule>> LoadAsync(CancellationToken ct)
    {
        if (!File.Exists(_filePath)) return [];

        try
        {
            await using var stream = File.OpenRead(_filePath);
            var rules = await JsonSerializer.DeserializeAsync<List<TopicColourRule>>(stream, cancellationToken: ct);
            // A file holding 'null' parses but carries no list.
            return rules ?? [];
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }

    // Writes to a temp file then swaps in, so an interrupted write can't corrupt the existing file
    public async Task SaveAsync(IReadOnlyList<TopicColourRule> rules, CancellationToken ct)
    {
        var directory = Path.GetDirectoryName(_filePath);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

        var tempPath = _filePath + ".tmp";
        await using (var stream = File.Create(tempPath))
        {
            await JsonSerializer.SerializeAsync(stream, rules, cancellationToken: ct);
        }

        File.Move(tempPath, _filePath, overwrite: true);
    }
}
