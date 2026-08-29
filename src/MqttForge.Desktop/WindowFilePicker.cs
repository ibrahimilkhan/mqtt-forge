using MqttForge.Domain.Abstractions;
using Photino.NET;

namespace MqttForge.Desktop;

/// <summary>
/// The host's own file dialog, which is the only kind available here.
/// </summary>
/// <remarks>
/// The window is on its own thread and the request that wants a file is not, so the call is
/// marshalled back to it — a dialog opened from a request thread either does nothing or takes the
/// window's own loop down with it, depending on the platform. The same reasoning, and the same
/// shape, as <see cref="WindowFolderPicker"/>.
/// </remarks>
public sealed class WindowFilePicker : IFilePicker
{
    private readonly PhotinoWindow _window;

    public WindowFilePicker(PhotinoWindow window) => _window = window;

    public Task<string?> PickAsync(
        string title, IReadOnlyList<FileFilter> filters, CancellationToken token = default)
    {
        var answered = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var menu = filters
            .Select(one => (one.Name, Extensions: one.Extensions.ToArray()))
            .ToArray();

        _window.Invoke(async () =>
        {
            try
            {
                var chosen = await _window.ShowOpenFileAsync(title, multiSelect: false, filters: menu);
                answered.TrySetResult(chosen is { Length: > 0 } ? chosen[0] : null);
            }
            catch (Exception ex)
            {
                answered.TrySetException(ex);
            }
        });

        // A dialog nobody answers must not hold a request open for the life of the process.
        return answered.Task.WaitAsync(TimeSpan.FromMinutes(5), token);
    }
}
