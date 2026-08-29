using MqttForge.Domain.Abstractions;

namespace MqttForge.Application.Services;

/// <summary>
/// The host's file dialog, pointed at the three files an encrypted connection can be given.
/// </summary>
/// <remarks>
/// It holds nothing. Unlike the export folder, which is a setting that outlives the save that used
/// it, a certificate path is on its way to a box in the broker form and the form is where it
/// lives; this only opens the dialog and hands back what came out.
/// <para>
/// What it does keep is the gate. Two consoles on one host is the ordinary case here — the QR
/// panel exists to put a second on a phone — and without it both of them asking put two dialogs on
/// one window, each holding a request open until somebody answered it.
/// </para>
/// </remarks>
public sealed class CertificatePicker
{
    /// <summary>Which of the three fields is being filled in, which is what names the dialog.</summary>
    public enum Kind
    {
        /// <summary>An extra root to verify the broker against.</summary>
        Authority,

        /// <summary>Our own certificate, which the broker authenticates us by.</summary>
        Certificate,

        /// <summary>The key that goes with a certificate that does not carry one.</summary>
        Key,
    }

    /// <summary>What came of asking the host for a file.</summary>
    public enum Choice
    {
        /// <summary>Answered with a file, and it is in <see cref="Answer.Path"/>.</summary>
        Chosen,

        /// <summary>
        /// Dismissed, or answered with a file that is not there. Either way nothing was chosen —
        /// 'not that one, then' is an answer rather than a failure.
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

    /// <summary>What the dialog said, and the file if it named one.</summary>
    public readonly record struct Answer(Choice Choice, string? Path);

    private readonly IFilePicker? _picker;

    // See the remarks above: one dialog at a time, and a second console asking while one is open
    // is turned away rather than queued behind it. Queued, its request would hang for as long as
    // the first went unanswered — up to the picker's own five minutes — and then open a dialog
    // nobody was waiting for any more.
    //
    // Not this service's own count: the export folder's dialog goes on the same window.
    private readonly HostDialogs _window;

    // Null when the host has no window to hang a dialog on — a plain `dotnet run`, or a test.
    public CertificatePicker(IFilePicker? picker = null, HostDialogs? window = null)
    {
        _picker = picker;
        // A service standing on its own is the only thing that could put a dialog up, so a window
        // of its own is the right default. A real host has one window and hands both services the
        // same one.
        _window = window ?? new HostDialogs();
    }

    /// <summary>Whether this host can ask for a file at all.</summary>
    public bool CanChoose => _picker is not null;

    /// <summary>
    /// What to call the dialog. Named for the field it is filling in rather than for the file it
    /// wants, because the two are not the same question and only one of them is on screen.
    /// </summary>
    public static string TitleFor(Kind kind) => kind switch
    {
        Kind.Authority => "Choose a CA certificate",
        Kind.Certificate => "Choose a client certificate",
        Kind.Key => "Choose a private key",
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, null),
    };

    /// <summary>
    /// The file-type menu, which is exactly what <c>CertificateFiles</c> knows how to open.
    /// </summary>
    /// <remarks>
    /// Every list ends with everything. The loader treats a file with no extension at all as PEM,
    /// which is a real thing to be handed and a thing no filter can name — and a dialog that will
    /// not show a reader the file they can see in Finder is a dialog they have to work around.
    /// </remarks>
    public static IReadOnlyList<FileFilter> FiltersFor(Kind kind) => kind switch
    {
        // PEM by extension, anything else read as DER. A PEM bundle may hold a whole chain, which
        // is what a broker behind an intermediate needs.
        Kind.Authority =>
        [
            new FileFilter("CA certificates", ["pem", "crt", "cer", "ca", "chain", "der"]),
            Everything,
        ],

        // PKCS#12 first: it carries its own key, so it is the one file that answers on its own.
        Kind.Certificate =>
        [
            new FileFilter("Certificates", ["pfx", "p12", "pem", "crt", "cer"]),
            Everything,
        ],

        Kind.Key =>
        [
            new FileFilter("Private keys", ["key", "pem"]),
            Everything,
        ],

        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, null),
    };

    private static FileFilter Everything => new("All files", ["*"]);

    /// <summary>Opens the host's dialog, and says what came back.</summary>
    /// <remarks>
    /// A file that is not there is reported as nothing chosen rather than passed on. An open
    /// dialog should not be able to name one, but a path that cannot be read is a connect failure
    /// several steps later, and the box this fills in is the last place it would be looked for.
    /// <para>
    /// The token belongs to this call and not to the dialog. Giving up on the answer is allowed —
    /// a console whose reader closed the tab is not owed one — but it does not take the dialog
    /// off the window, because nothing can: no host here offers a way to close a dialog it has
    /// already put up. So the gate stays shut until that dialog is answered, and a request that
    /// walked away cannot leave the next one free to stack a second dialog on top of the first.
    /// </para>
    /// </remarks>
    public async Task<Answer> ChooseAsync(Kind kind, CancellationToken token = default)
    {
        if (_picker is null) return new Answer(Choice.Unavailable, null);

        // No token passed on: the picker's own five minutes are what bound a dialog nobody
        // answers, and they are about the dialog rather than about this call.
        var dialog = _window.Show(() => _picker.PickAsync(TitleFor(kind), FiltersFor(kind)));
        if (dialog is null) return new Answer(Choice.AlreadyOpen, null);

        var chosen = await dialog.WaitAsync(token);

        return string.IsNullOrWhiteSpace(chosen) || !File.Exists(chosen)
            ? new Answer(Choice.Unchanged, null)
            : new Answer(Choice.Chosen, chosen);
    }
}
