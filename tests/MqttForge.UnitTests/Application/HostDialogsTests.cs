using MqttForge.Application.Services;
using MqttForge.Domain.Abstractions;
using NSubstitute;
using Xunit;

namespace MqttForge.UnitTests.Application;

/// <summary>
/// One window, one dialog on it.
///
/// Each service used to keep its own count, which let the window hold one of each: the file
/// dialog under Encryption standing under the folder dialog the chart panel opened. A count per
/// service counts the wrong thing — the window is what there is only one of.
/// </summary>
public class HostDialogsTests
{
    private static string TempFolder()
    {
        var path = Path.Combine(Path.GetTempPath(), $"mqttforge-window-{Guid.NewGuid():N}");
        Directory.CreateDirectory(path);

        return path;
    }

    [Fact]
    public async Task A_file_dialog_and_a_folder_dialog_cannot_stand_on_one_window()
    {
        using var window = new HostDialogs();
        var opened = new TaskCompletionSource();
        var answered = new TaskCompletionSource<string?>();

        var folders = Substitute.For<IFolderPicker>();
        folders.PickAsync(Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(_ =>
        {
            opened.TrySetResult();
            return answered.Task;
        });
        var files = Substitute.For<IFilePicker>();

        var export = new ExportService(folders, window);
        var certificates = new CertificatePicker(files, window);

        var choosing = export.ChooseAsync();
        await opened.Task;

        var second = await certificates.ChooseAsync(CertificatePicker.Kind.Certificate);

        Assert.Equal(CertificatePicker.Choice.AlreadyOpen, second.Choice);
        // Not even asked for: the window was taken, so no second dialog was built to put on it.
        await files
            .DidNotReceive()
            .PickAsync(Arg.Any<string>(), Arg.Any<IReadOnlyList<FileFilter>>(), Arg.Any<CancellationToken>());

        answered.SetResult(TempFolder());
        Assert.Equal(ExportService.Choice.Chosen, await choosing);
    }

    // And the other way round, since neither service is the one that owns the window.
    [Fact]
    public async Task A_folder_dialog_waits_for_a_file_dialog_just_the_same()
    {
        using var window = new HostDialogs();
        var opened = new TaskCompletionSource();
        var answered = new TaskCompletionSource<string?>();

        var files = Substitute.For<IFilePicker>();
        files
            .PickAsync(Arg.Any<string>(), Arg.Any<IReadOnlyList<FileFilter>>(), Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                opened.TrySetResult();
                return answered.Task;
            });
        var folders = Substitute.For<IFolderPicker>();

        var certificates = new CertificatePicker(files, window);
        var export = new ExportService(folders, window);

        var choosing = certificates.ChooseAsync(CertificatePicker.Kind.Authority);
        await opened.Task;

        Assert.Equal(ExportService.Choice.AlreadyOpen, await export.ChooseAsync());
        await folders.DidNotReceive().PickAsync(Arg.Any<string>(), Arg.Any<CancellationToken>());

        answered.SetResult(null);
        Assert.Equal(CertificatePicker.Choice.Unchanged, (await choosing).Choice);
    }

    // A service built without one is the only thing that could put a dialog up, so it gets a
    // window of its own rather than a null to check for.
    [Fact]
    public async Task A_service_with_no_window_given_to_it_still_keeps_one_dialog_at_a_time()
    {
        var opened = new TaskCompletionSource();
        var answered = new TaskCompletionSource<string?>();
        var files = Substitute.For<IFilePicker>();
        files
            .PickAsync(Arg.Any<string>(), Arg.Any<IReadOnlyList<FileFilter>>(), Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                opened.TrySetResult();
                return answered.Task;
            });
        var sut = new CertificatePicker(files);

        var choosing = sut.ChooseAsync(CertificatePicker.Kind.Certificate);
        await opened.Task;

        var second = await sut.ChooseAsync(CertificatePicker.Kind.Key);

        Assert.Equal(CertificatePicker.Choice.AlreadyOpen, second.Choice);

        answered.SetResult(null);
        Assert.Equal(CertificatePicker.Choice.Unchanged, (await choosing).Choice);
    }
}
