namespace MqttForge.Domain.Abstractions;

/// <summary>
/// Asks the person at the keyboard for a file, using whatever dialog the host has.
/// </summary>
/// <remarks>
/// The browser cannot stand in for this, and not for the reason it looks like. A file input does
/// open a dialog — it is the one thing about files a plain page can do — but what it hands back is
/// the bytes with the path deliberately hidden, and the bytes are no use here. The connection is
/// held by the server, so what a certificate field needs is a path that means something where that
/// server runs, and only the host that owns the window can ask for one of those.
/// <para>
/// So the dialog belongs to that host, the same way the folder dialog does, and nothing else in
/// the app knows which host it is: a run with no window registers no picker and the fields stay
/// what they always were, boxes you type a path into.
/// </para>
/// </remarks>
public interface IFilePicker
{
    /// <summary>The file chosen, or null when the dialog was dismissed.</summary>
    Task<string?> PickAsync(
        string title, IReadOnlyList<FileFilter> filters, CancellationToken token = default);
}

/// <summary>One line of a dialog's file-type menu: what to call it, and what it matches.</summary>
/// <remarks>
/// Extensions are written bare, without the dot — <c>pem</c>, not <c>.pem</c> — which is what
/// every one of these dialogs wants underneath whatever it calls the argument.
/// </remarks>
public sealed record FileFilter(string Name, IReadOnlyList<string> Extensions);
