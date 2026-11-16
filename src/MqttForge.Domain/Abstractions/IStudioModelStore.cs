namespace MqttForge.Domain.Abstractions;

/// <summary>
/// The model files studio scenes point at, kept apart from the scenes so a scene save is a few
/// kilobytes of JSON rather than the whole of every part in it, base64'd.
/// </summary>
// Content-addressed: the key is the file's hash, so the same part dropped into ten scenes is one
// file, and a key can be cached for good by whoever reads it — what it names can never change.
public interface IStudioModelStore
{
    /// <summary>Stores the bytes and answers their key.</summary>
    /// <exception cref="ArgumentException">The extension is not one the studio keeps.</exception>
    /// <exception cref="Exceptions.StudioNotSavedException">The file could not be written.</exception>
    Task<string> PutAsync(Stream content, string extension, CancellationToken ct);

    /// <summary>The file, or null when the key is not one or nothing is stored under it.</summary>
    Stream? OpenRead(string key);

    /// <summary>Deletes every stored file not in <paramref name="keep"/> and older than <paramref name="grace"/>; answers how many went.</summary>
    int DeleteUnused(IReadOnlySet<string> keep, TimeSpan grace);
}
