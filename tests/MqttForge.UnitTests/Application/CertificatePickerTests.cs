using MqttForge.Application.Services;
using MqttForge.Domain.Abstractions;
using NSubstitute;
using Xunit;

namespace MqttForge.UnitTests.Application;

public class CertificatePickerTests
{
    private readonly IFilePicker _picker = Substitute.For<IFilePicker>();

    private static string TempFile(string name = "client.pfx")
    {
        var folder = Path.Combine(Path.GetTempPath(), $"mqttforge-cert-{Guid.NewGuid():N}");
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, name);
        File.WriteAllText(path, "not really a certificate");

        return path;
    }

    [Fact]
    public void CanChoose_is_false_where_the_host_has_no_window()
    {
        Assert.False(new CertificatePicker().CanChoose);
    }

    [Fact]
    public async Task ChooseAsync_says_so_where_the_host_has_no_window()
    {
        var answer = await new CertificatePicker().ChooseAsync(CertificatePicker.Kind.Certificate);

        Assert.Equal(CertificatePicker.Choice.Unavailable, answer.Choice);
        Assert.Null(answer.Path);
    }

    [Fact]
    public async Task ChooseAsync_hands_back_the_file_the_dialog_named()
    {
        var file = TempFile();
        Returning(file);

        var answer = await new CertificatePicker(_picker).ChooseAsync(CertificatePicker.Kind.Certificate);

        Assert.Equal(CertificatePicker.Choice.Chosen, answer.Choice);
        Assert.Equal(file, answer.Path);
    }

    // Dismissing is an answer — 'not that one, then' — and the box it would have filled is left as
    // it was. A failure here would put an error in front of somebody who only changed their mind.
    [Fact]
    public async Task A_dismissed_dialog_chooses_nothing_rather_than_failing()
    {
        Returning(null);

        var answer = await new CertificatePicker(_picker).ChooseAsync(CertificatePicker.Kind.Authority);

        Assert.Equal(CertificatePicker.Choice.Unchanged, answer.Choice);
        Assert.Null(answer.Path);
    }

    // An open dialog should not be able to name a file that is not there, but the box this fills
    // in is the last place a reader would look for the reason a connect failed several steps later.
    [Fact]
    public async Task A_file_that_is_not_there_is_not_handed_on()
    {
        Returning(Path.Combine(Path.GetTempPath(), $"mqttforge-gone-{Guid.NewGuid():N}.pem"));

        var answer = await new CertificatePicker(_picker).ChooseAsync(CertificatePicker.Kind.Key);

        Assert.Equal(CertificatePicker.Choice.Unchanged, answer.Choice);
        Assert.Null(answer.Path);
    }

    // Two consoles on one host is what this app is for — the QR panel exists to put a second one
    // on a phone — so two of them asking for a file at once is the ordinary case, not the odd one.
    // Both got a dialog: two of them on one window, each holding a request open until somebody
    // answered it, and the picker gives an unanswered dialog five minutes.
    [Fact]
    public async Task ChooseAsync_turns_away_a_second_console_while_a_dialog_is_open()
    {
        var file = TempFile();
        var opened = new TaskCompletionSource();
        var answered = new TaskCompletionSource<string?>();
        _picker
            .PickAsync(Arg.Any<string>(), Arg.Any<IReadOnlyList<FileFilter>>(), Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                opened.TrySetResult();
                return answered.Task;
            });
        var sut = new CertificatePicker(_picker);

        var first = sut.ChooseAsync(CertificatePicker.Kind.Certificate);
        await opened.Task;

        var second = await sut.ChooseAsync(CertificatePicker.Kind.Authority);
        Assert.Equal(CertificatePicker.Choice.AlreadyOpen, second.Choice);

        answered.SetResult(file);
        Assert.Equal(CertificatePicker.Choice.Chosen, (await first).Choice);
        // One dialog was put on the window, not two.
        await _picker
            .Received(1)
            .PickAsync(Arg.Any<string>(), Arg.Any<IReadOnlyList<FileFilter>>(), Arg.Any<CancellationToken>());
    }

    // And the gate opens again afterwards: a console turned away must not be turned away for ever.
    [Fact]
    public async Task ChooseAsync_asks_again_once_the_dialog_is_answered()
    {
        Returning(TempFile());
        var sut = new CertificatePicker(_picker);

        await sut.ChooseAsync(CertificatePicker.Kind.Certificate);

        var again = await sut.ChooseAsync(CertificatePicker.Kind.Certificate);
        Assert.Equal(CertificatePicker.Choice.Chosen, again.Choice);
    }

    // The dialog is named for the box being filled in, not for the file it wants: three dialogs
    // all called 'Choose a certificate' would tell a reader nothing about which of the three
    // buttons they pressed.
    [Theory]
    [InlineData(CertificatePicker.Kind.Authority, "CA certificate")]
    [InlineData(CertificatePicker.Kind.Certificate, "client certificate")]
    [InlineData(CertificatePicker.Kind.Key, "private key")]
    public void TitleFor_names_the_field_rather_than_the_file(CertificatePicker.Kind kind, string said)
    {
        Assert.Contains(said, CertificatePicker.TitleFor(kind));
    }

    // Exactly what CertificateFiles knows how to open, so the dialog cannot offer a file the
    // loader will then refuse.
    [Theory]
    [InlineData(CertificatePicker.Kind.Authority, "pem", "crt", "cer", "ca", "chain", "der")]
    [InlineData(CertificatePicker.Kind.Certificate, "pfx", "p12", "pem", "crt", "cer")]
    [InlineData(CertificatePicker.Kind.Key, "key", "pem")]
    public void FiltersFor_offers_what_the_loader_can_read(
        CertificatePicker.Kind kind, params string[] expected)
    {
        Assert.Equal(expected, CertificatePicker.FiltersFor(kind)[0].Extensions);
    }

    // The loader reads a file with no extension at all as PEM, which is a real thing to be handed
    // and a thing no filter can name. A dialog that will not show a reader the file they can see
    // in their own file manager is a dialog they have to work around.
    [Theory]
    [InlineData(CertificatePicker.Kind.Authority)]
    [InlineData(CertificatePicker.Kind.Certificate)]
    [InlineData(CertificatePicker.Kind.Key)]
    public void FiltersFor_ends_with_everything(CertificatePicker.Kind kind)
    {
        Assert.Equal(["*"], CertificatePicker.FiltersFor(kind)[^1].Extensions);
    }

    private void Returning(string? path) =>
        _picker
            .PickAsync(Arg.Any<string>(), Arg.Any<IReadOnlyList<FileFilter>>(), Arg.Any<CancellationToken>())
            .Returns(path);
}
