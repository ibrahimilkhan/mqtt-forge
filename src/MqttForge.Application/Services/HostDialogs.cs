namespace MqttForge.Application.Services;

/// <summary>
/// The one window, and the one dialog that can be standing on it.
/// </summary>
/// <remarks>
/// A host has a single window, so there is a single place a dialog can go. Two services ask for
/// one — a folder to write readings into, and a file to read a certificate from — and each
/// keeping its own count let the window hold one of each: a file dialog under a folder dialog,
/// which is exactly the pile-up a count exists to prevent. One count, in front of both.
/// <para>
/// The count is held by the dialog, not by whoever asked for it. A request that gives up waiting
/// — a reader who closed the tab — does not take the dialog off the window, because nothing can:
/// no host here offers a way to close one it has already put up. So the window stays occupied
/// until that dialog is answered, and the next console is turned away rather than left to stack a
/// second dialog on top of the first.
/// </para>
/// </remarks>
public sealed class HostDialogs : IDisposable
{
    private readonly SemaphoreSlim _window = new(1, 1);

    /// <summary>
    /// Puts a dialog on the window, if nothing is standing on it.
    /// </summary>
    /// <returns>
    /// The dialog, from the moment it goes up to the moment it is answered — or null when the
    /// window already has one, which is a second console asking rather than a failure.
    /// </returns>
    public Task<string?>? Show(Func<Task<string?>> open)
    {
        // Wait(0) rather than a wait: there is nothing here worth queueing for. Either the window
        // is free at the moment of asking or the caller is told that it is not.
        if (!_window.Wait(0)) return null;

        var dialog = Held(open);

        // Read however it ends, whether or not the caller stays to hear it. One that gave up
        // leaves nobody looking at the dialog's own outcome — and a picker's own timeout ends in
        // a fault rather than a result — so without this a reader who closed their tab could be
        // followed by an unobserved exception with nothing left on screen to explain it.
        _ = dialog.ContinueWith(
            static ended => _ = ended.Exception,
            CancellationToken.None,
            TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);

        return dialog;
    }

    public void Dispose() => _window.Dispose();

    /// <summary>The dialog with the window held for exactly as long as it is up.</summary>
    private async Task<string?> Held(Func<Task<string?>> open)
    {
        try
        {
            return await open();
        }
        finally
        {
            _window.Release();
        }
    }
}
