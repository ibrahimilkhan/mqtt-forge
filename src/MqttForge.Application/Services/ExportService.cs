using MqttForge.Domain.Abstractions;

namespace MqttForge.Application.Services;

/// <summary>
/// Where the readings go when they leave the console, and the writing of them.
/// </summary>
/// <remarks>
/// The folder can only be set by the host's own dialog. That is deliberate: the server binds to a
/// LAN address, so an endpoint taking a path from its caller would let anyone who can reach the
/// port write a file anywhere the process can. Here the only path that can ever be written to is
/// one the person at the keyboard chose in a native dialog, the name is reduced to a bare leaf,
/// and the content is capped — so the worst a stranger on the network can do is leave a file in a
/// folder its owner already opened, which is a great deal less than the publish endpoint already
/// allows them.
/// </remarks>
public sealed class ExportService
{
    /// <summary>Enough for the longest run the chart can hold, and far short of a disk filler.</summary>
    public const int LargestExport = 8 * 1024 * 1024;

    private readonly IFolderPicker? _picker;
    private string? _folder;

    // Null when the host has no window to hang a dialog on — a plain `dotnet run`, or a test.
    public ExportService(IFolderPicker? picker = null) => _picker = picker;

    /// <summary>Whether this host can ask for a folder at all.</summary>
    public bool CanChoose => _picker is not null;

    /// <summary>The folder in force, or null while none has been chosen.</summary>
    public string? Folder => _folder;

    /// <summary>
    /// Opens the host's dialog and remembers what came back.
    /// </summary>
    /// <remarks>
    /// A folder that has since been deleted or unmounted is not remembered: the reader would
    /// otherwise be shown a path that every save is going to fail against.
    /// </remarks>
    public async Task<string?> ChooseAsync(CancellationToken token = default)
    {
        if (_picker is null) return null;

        var chosen = await _picker.PickAsync("Where to save the readings", token);
        if (string.IsNullOrWhiteSpace(chosen) || !Directory.Exists(chosen)) return null;

        _folder = chosen;

        return _folder;
    }

    /// <summary>Writes one file into the chosen folder, and says where it landed.</summary>
    public async Task<string> SaveAsync(string name, string content, CancellationToken token = default)
    {
        if (_folder is null) throw new InvalidOperationException("No folder has been chosen.");
        if (!Directory.Exists(_folder)) throw new DirectoryNotFoundException(_folder);
        if (content.Length > LargestExport) throw new ArgumentOutOfRangeException(nameof(content));

        var path = Path.Combine(_folder, FileName(name));
        await File.WriteAllTextAsync(path, content, token);

        return path;
    }

    /// <summary>
    /// A bare file name, whatever was asked for.
    /// </summary>
    /// <remarks>
    /// Every character that is not plainly safe becomes a dash, which takes the separators with
    /// it — so a name cannot climb out of the folder or name a device. An empty result falls back
    /// rather than writing a file called nothing.
    /// </remarks>
    public static string FileName(string asked)
    {
        var safe = new string([.. asked.Select(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' ? c : '-')])
            .Trim('-');

        if (safe.Length == 0) safe = "readings";

        // Long enough for a topic path and a timestamp; short of every filesystem's own limit.
        return $"{safe[..Math.Min(safe.Length, 120)]}.csv";
    }
}
