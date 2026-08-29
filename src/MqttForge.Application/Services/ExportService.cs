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

    /// <summary>What came of asking the host for a folder.</summary>
    public enum Choice
    {
        /// <summary>Answered with a folder, and it is now the one in force.</summary>
        Chosen,

        /// <summary>
        /// Dismissed, or answered with a folder that is not there. Either way the folder in force
        /// is unchanged — 'not there, then' is an answer rather than a failure.
        /// </summary>
        Unchanged,

        /// <summary>
        /// Someone else's dialog is open on the window already, and a second was not put on top
        /// of it.
        /// </summary>
        AlreadyOpen,

        /// <summary>This host has no window, so there is no dialog to open.</summary>
        Unavailable,
    }

    private readonly IFolderPicker? _picker;

    // One dialog at a time, and the count is not this service's own: the file dialog under
    // Encryption goes on the same window. Two consoles on one host is the ordinary case rather
    // than the strange one — the QR panel exists to put a second on a phone — and without this
    // both of them asking put two dialogs on one window, each holding a request open until
    // somebody answered it.
    private readonly HostDialogs _window;

    // Written by whoever answered the dialog and read by any request; through Volatile so a
    // console that asks straight after choosing is not shown the folder from before.
    private string? _folder;

    // Null when the host has no window to hang a dialog on — a plain `dotnet run`, or a test.
    public ExportService(IFolderPicker? picker = null, HostDialogs? window = null)
    {
        _picker = picker;
        // A service standing on its own is the only thing that could put a dialog up, so a window
        // of its own is the right default. A real host has one window and hands both services the
        // same one.
        _window = window ?? new HostDialogs();
    }

    /// <summary>Whether this host can ask for a folder at all.</summary>
    public bool CanChoose => _picker is not null;

    /// <summary>The folder in force, or null while none has been chosen.</summary>
    public string? Folder => Volatile.Read(ref _folder);

    /// <summary>
    /// Opens the host's dialog and remembers what came back.
    /// </summary>
    /// <remarks>
    /// A folder that has since been deleted or unmounted is not remembered: the reader would
    /// otherwise be shown a path that every save is going to fail against.
    /// <para>
    /// A second console asking while a dialog is open is turned away rather than queued behind it.
    /// Queued, its request would hang for as long as the first dialog went unanswered — up to the
    /// picker's own five minutes — and then open a dialog nobody was waiting for any more.
    /// </para>
    /// <para>
    /// The token belongs to this call and not to the dialog. Giving up on the answer is allowed —
    /// a console whose reader closed the tab is not owed one — but it does not take the dialog
    /// off the window, because nothing can: no host here offers a way to close a dialog it has
    /// already put up. So the gate stays shut until that dialog is answered, and a request that
    /// walked away cannot leave the next one free to stack a second dialog on top of the first.
    /// </para>
    /// </remarks>
    public async Task<Choice> ChooseAsync(CancellationToken token = default)
    {
        if (_picker is null) return Choice.Unavailable;

        // No token passed on: the picker's own five minutes are what bound a dialog nobody
        // answers, and they are about the dialog rather than about this call.
        var dialog = _window.Show(() => _picker.PickAsync("Where to save the readings"));
        if (dialog is null) return Choice.AlreadyOpen;

        var chosen = await dialog.WaitAsync(token);
        if (string.IsNullOrWhiteSpace(chosen) || !Directory.Exists(chosen)) return Choice.Unchanged;

        Volatile.Write(ref _folder, chosen);

        return Choice.Chosen;
    }

    /// <summary>Writes one file into the chosen folder, and says where it landed.</summary>
    public async Task<string> SaveAsync(string name, string content, CancellationToken token = default)
    {
        var folder = Folder;
        if (folder is null) throw new InvalidOperationException("No folder has been chosen.");
        if (!Directory.Exists(folder)) throw new DirectoryNotFoundException(folder);
        if (content.Length > LargestExport) throw new ArgumentOutOfRangeException(nameof(content));

        var path = Path.Combine(folder, FileName(name));
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
