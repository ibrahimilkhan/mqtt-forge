using System.Text.Json;
using MQFaker.Domain.Abstractions;
using MQFaker.Domain.Models;

namespace MQFaker.Infrastructure.Persistence;

public sealed class JsonConnectionSettingsStore : IConnectionSettingsStore
{
    private readonly string _filePath;

    public JsonConnectionSettingsStore(string filePath) => _filePath = filePath;

    // Bozuk/okunamayan dosyayı hata olarak değil "kayıt yok" olarak ele alır;
    // ayarlar yalnızca bir kolaylık önbelleği olduğu için uygulama kendi kendini toparlar.
    public async Task<BrokerConnectionSettings?> LoadAsync(CancellationToken ct)
    {
        if (!File.Exists(_filePath)) return null;

        try
        {
            await using var stream = File.OpenRead(_filePath);
            return await JsonSerializer.DeserializeAsync<BrokerConnectionSettings>(stream, cancellationToken: ct);
        }
        catch (Exception ex) when (ex is JsonException or IOException)
        {
            return null;
        }
    }

    // Önce geçici dosyaya yazıp sonra yer değiştirir; yazma yarıda kalırsa
    // mevcut ayar dosyası bozulmadan kalır.
    public async Task SaveAsync(BrokerConnectionSettings settings, CancellationToken ct)
    {
        var directory = Path.GetDirectoryName(_filePath);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

        var tempPath = _filePath + ".tmp";
        await using (var stream = File.Create(tempPath))
        {
            await JsonSerializer.SerializeAsync(stream, settings, cancellationToken: ct);
        }

        File.Move(tempPath, _filePath, overwrite: true);
    }
}
