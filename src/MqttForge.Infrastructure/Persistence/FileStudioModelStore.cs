using System.Security.Cryptography;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;

namespace MqttForge.Infrastructure.Persistence;

public sealed class FileStudioModelStore : IStudioModelStore
{
    private const int BufferBytes = 81920;

    private readonly string _directory;
    private readonly TimeProvider _time;

    public FileStudioModelStore(string studioDirectory, TimeProvider? time = null)
    {
        _directory = Path.Combine(studioDirectory, "models");
        _time = time ?? TimeProvider.System;
    }

    public async Task<string> PutAsync(Stream content, string extension, CancellationToken ct)
    {
        var ext = extension.ToLowerInvariant();
        if (!StudioIds.IsModelExtension(ext))
            throw new ArgumentException($"'{extension}' is not a model format the studio keeps.", nameof(extension));

        // Written under a name of its own first, because the name it ends up under is not known
        // until the last byte has been hashed.
        var temp = Path.Combine(_directory, $"upload-{Guid.NewGuid():N}.tmp");
        try
        {
            Directory.CreateDirectory(_directory);
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            var buffer = new byte[BufferBytes];

            await using (var file = File.Create(temp))
            {
                int read;
                while ((read = await content.ReadAsync(buffer, ct)) > 0)
                {
                    hash.AppendData(buffer, 0, read);
                    await file.WriteAsync(buffer.AsMemory(0, read), ct);
                }
            }

            var key = Convert.ToHexStringLower(hash.GetHashAndReset()) + ext;
            var target = Path.Combine(_directory, key);

            if (File.Exists(target))
            {
                File.Delete(temp);
            }
            else
            {
                try
                {
                    File.Move(temp, target);
                }
                catch (IOException) when (File.Exists(target))
                {
                    // Another request stored the same bytes first; content-addressed keys mean its file is ours.
                    File.Delete(temp);
                }
            }
            // Touched, so the grace in DeleteUnused counts from this upload and not the first:
            // the scene about to name it again has not been saved yet.
            File.SetLastWriteTimeUtc(target, _time.GetUtcNow().UtcDateTime);

            return key;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            if (File.Exists(temp)) File.Delete(temp);
            throw new StudioNotSavedException($"Could not store the model in {_directory}: {ex.Message}", ex);
        }
    }

    public Stream? OpenRead(string key)
    {
        if (!StudioIds.IsModelKey(key)) return null;

        var path = Path.Combine(_directory, key);
        return File.Exists(path) ? File.OpenRead(path) : null;
    }

    public int DeleteUnused(IReadOnlySet<string> keep, TimeSpan grace)
    {
        if (!Directory.Exists(_directory)) return 0;

        var cutoff = _time.GetUtcNow().UtcDateTime - grace;
        var deleted = 0;

        foreach (var path in Directory.EnumerateFiles(_directory))
        {
            var name = Path.GetFileName(path);
            // Only files this store named. An upload half written is someone's request in flight.
            if (!StudioIds.IsModelKey(name) || keep.Contains(name)) continue;
            if (File.GetLastWriteTimeUtc(path) > cutoff) continue;

            File.Delete(path);
            deleted++;
        }

        return deleted;
    }
}
