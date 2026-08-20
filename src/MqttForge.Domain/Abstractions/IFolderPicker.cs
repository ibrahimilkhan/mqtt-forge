namespace MqttForge.Domain.Abstractions;

/// <summary>
/// Asks the person at the keyboard for a folder, using whatever dialog the host has.
/// </summary>
/// <remarks>
/// The browser cannot do this. <c>showDirectoryPicker</c> needs a secure context, and the desktop
/// window loads a LAN address over plain http so that the QR panel has something a phone can
/// reach — which is not one. That is the same reason the clipboard API is missing there. So the
/// dialog belongs to the host that owns the window, and nothing else in the app knows which host
/// that is; a run with no window registers no picker and the interface falls back to a download.
/// </remarks>
public interface IFolderPicker
{
    /// <summary>The folder chosen, or null when the dialog was dismissed.</summary>
    Task<string?> PickAsync(string title, CancellationToken token = default);
}
