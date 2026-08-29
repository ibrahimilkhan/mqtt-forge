using MqttForge.Application.Services;
using MqttForge.Domain.Abstractions;
using NSubstitute;
using Xunit;

namespace MqttForge.UnitTests.Application;

public class ExportServiceTests
{
    private readonly IFolderPicker _picker = Substitute.For<IFolderPicker>();

    private static string TempFolder()
    {
        var path = Path.Combine(Path.GetTempPath(), $"mqttforge-export-{Guid.NewGuid():N}");
        Directory.CreateDirectory(path);

        return path;
    }

    [Fact]
    public void CanChoose_is_false_where_the_host_has_no_window()
    {
        Assert.False(new ExportService().CanChoose);
    }

    [Fact]
    public async Task ChooseAsync_says_so_where_the_host_has_no_window()
    {
        Assert.Equal(ExportService.Choice.Unavailable, await new ExportService().ChooseAsync());
    }

    // Two consoles on one host is what this app is for — the QR panel exists to put a second one
    // on a phone — so two of them asking for a folder at once is the ordinary case, not the odd
    // one. Both got a dialog: two of them on one window, each holding a request open until
    // somebody answered it, and the picker gives an unanswered dialog five minutes.
    [Fact]
    public async Task ChooseAsync_turns_away_a_second_console_while_a_dialog_is_open()
    {
        var folder = TempFolder();
        var opened = new TaskCompletionSource();
        var answer = new TaskCompletionSource<string?>();
        _picker.PickAsync(Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(_ =>
        {
            opened.TrySetResult();
            return answer.Task;
        });
        var sut = new ExportService(_picker);

        var first = sut.ChooseAsync();
        await opened.Task;

        Assert.Equal(ExportService.Choice.AlreadyOpen, await sut.ChooseAsync());

        answer.SetResult(folder);
        Assert.Equal(ExportService.Choice.Chosen, await first);
        // One dialog was put on the window, not two.
        await _picker.Received(1).PickAsync(Arg.Any<string>(), Arg.Any<CancellationToken>());
    }

    // A request is not the dialog. A console whose reader closed the tab stops waiting for an
    // answer — that much is right — but nothing takes the dialog off the window, because no host
    // here offers a way to close one it has already put up. Released with the request, the gate
    // let the next console stack a second dialog on top of the first, which is the one thing it
    // exists to stop.
    [Fact]
    public async Task ChooseAsync_leaves_the_gate_shut_behind_a_caller_that_gives_up()
    {
        var folder = TempFolder();
        var opened = new TaskCompletionSource();
        var answered = new TaskCompletionSource<string?>();
        _picker.PickAsync(Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(_ =>
        {
            opened.TrySetResult();
            return answered.Task;
        });
        var sut = new ExportService(_picker);
        using var gaveUp = new CancellationTokenSource();

        var first = sut.ChooseAsync(gaveUp.Token);
        await opened.Task;
        await gaveUp.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => first);

        // The dialog is still up, so the next console is still turned away.
        Assert.Equal(ExportService.Choice.AlreadyOpen, await sut.ChooseAsync());
        await _picker.Received(1).PickAsync(Arg.Any<string>(), Arg.Any<CancellationToken>());

        // And the gate opens when that dialog is answered, which is the only thing that opens it.
        answered.SetResult(folder);
        Assert.Equal(ExportService.Choice.Chosen, await Eventually(sut.ChooseAsync));
    }

    // The gate is given back by the dialog's own continuation, and the test runner's
    // synchronisation context posts that rather than running it inline — so it lands a moment
    // after SetResult returns rather than during it. Asking again is free: a gate still shut says
    // so and opens nothing.
    private static async Task<ExportService.Choice> Eventually(
        Func<CancellationToken, Task<ExportService.Choice>> ask)
    {
        for (var attempt = 0; attempt < 200; attempt++)
        {
            var answer = await ask(CancellationToken.None);
            if (answer != ExportService.Choice.AlreadyOpen) return answer;

            await Task.Delay(5);
        }

        throw new TimeoutException("The gate never opened.");
    }

    // And the gate opens again afterwards: a console turned away must not be turned away for ever.
    [Fact]
    public async Task ChooseAsync_asks_again_once_the_dialog_is_answered()
    {
        var folder = TempFolder();
        _picker.PickAsync(Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(folder);
        var sut = new ExportService(_picker);

        await sut.ChooseAsync();

        Assert.Equal(ExportService.Choice.Chosen, await sut.ChooseAsync());
    }

    [Fact]
    public async Task ChooseAsync_remembers_what_the_dialog_returned()
    {
        var folder = TempFolder();
        _picker.PickAsync(Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(folder);
        var sut = new ExportService(_picker);

        Assert.Equal(ExportService.Choice.Chosen, await sut.ChooseAsync());
        Assert.Equal(folder, sut.Folder);
    }

    // Dismissing the dialog is an answer, not a failure, and it must not clear a folder that was
    // already working.
    [Fact]
    public async Task ChooseAsync_leaves_the_folder_alone_when_the_dialog_is_dismissed()
    {
        var folder = TempFolder();
        _picker.PickAsync(Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(folder, (string?)null);
        var sut = new ExportService(_picker);
        await sut.ChooseAsync();

        Assert.Equal(ExportService.Choice.Unchanged, await sut.ChooseAsync());
        Assert.Equal(folder, sut.Folder);
    }

    // A path that no longer resolves would be shown to the reader as where their files are going,
    // and every save against it would fail.
    [Fact]
    public async Task ChooseAsync_refuses_a_folder_that_is_not_there()
    {
        _picker.PickAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(Path.Combine(Path.GetTempPath(), $"missing-{Guid.NewGuid():N}"));
        var sut = new ExportService(_picker);

        Assert.Equal(ExportService.Choice.Unchanged, await sut.ChooseAsync());
        Assert.Null(sut.Folder);
    }

    [Fact]
    public async Task SaveAsync_writes_the_content_and_says_where()
    {
        var folder = TempFolder();
        _picker.PickAsync(Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(folder);
        var sut = new ExportService(_picker);
        await sut.ChooseAsync();

        var path = await sut.SaveAsync("sensors-room-temp", "time,temp\n2026-08-20T00:00:00Z,21.5");

        Assert.Equal(folder, Path.GetDirectoryName(path));
        Assert.Contains("21.5", await File.ReadAllTextAsync(path));
    }

    [Fact]
    public async Task SaveAsync_refuses_before_a_folder_has_been_chosen()
    {
        await Assert.ThrowsAsync<InvalidOperationException>(() => new ExportService().SaveAsync("a", "b"));
    }

    // The server binds to a LAN address, so a name is a hostile string until it has been reduced
    // to a leaf: no separators, no traversal, nothing that names a device.
    [Theory]
    [InlineData("../../etc/passwd", "etc-passwd.csv")]
    [InlineData("/absolute/path", "absolute-path.csv")]
    [InlineData("sensors/room/temp", "sensors-room-temp.csv")]
    [InlineData("..", "readings.csv")]
    [InlineData("", "readings.csv")]
    [InlineData("con", "con.csv")]
    [InlineData("a:b*c?d", "a-b-c-d.csv")]
    public void FileName_reduces_anything_to_a_bare_leaf(string asked, string expected)
    {
        Assert.Equal(expected, ExportService.FileName(asked));
    }

    [Fact]
    public void FileName_never_outgrows_a_filesystem_limit()
    {
        Assert.True(ExportService.FileName(new string('a', 5000)).Length <= 124);
    }

    // Proved rather than argued: whatever the name asks for, the file lands in the chosen folder.
    [Theory]
    [InlineData("../../escaped")]
    [InlineData("/etc/passwd")]
    public async Task SaveAsync_cannot_be_talked_out_of_the_chosen_folder(string name)
    {
        var folder = TempFolder();
        _picker.PickAsync(Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(folder);
        var sut = new ExportService(_picker);
        await sut.ChooseAsync();

        var path = await sut.SaveAsync(name, "time,x\n");

        Assert.Equal(folder, Path.GetDirectoryName(path));
    }

    [Fact]
    public async Task SaveAsync_refuses_a_run_larger_than_the_cap()
    {
        var folder = TempFolder();
        _picker.PickAsync(Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(folder);
        var sut = new ExportService(_picker);
        await sut.ChooseAsync();

        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(
            () => sut.SaveAsync("big", new string('x', ExportService.LargestExport + 1)));
    }
}
