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
    public async Task ChooseAsync_remembers_what_the_dialog_returned()
    {
        var folder = TempFolder();
        _picker.PickAsync(Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(folder);
        var sut = new ExportService(_picker);

        Assert.Equal(folder, await sut.ChooseAsync());
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

        Assert.Null(await sut.ChooseAsync());
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

        Assert.Null(await sut.ChooseAsync());
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
