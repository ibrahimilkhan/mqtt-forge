using System.Net;
using System.Net.Http.Json;
using System.Text;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using MqttForge.Domain.Abstractions;
using NSubstitute;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

/// <summary>
/// The endpoint that fills in a certificate path by opening a dialog on the host.
///
/// The path is not taken from the caller and nothing is remembered here: what comes back goes into
/// a box in the broker form, and the form sends it with the next connect like any other path. What
/// this covers is the two answers a console has to be able to tell apart — a host with no window,
/// which is every browser, and a dialog somebody dismissed.
/// </summary>
public sealed class CertificateFileEndpointTests
{
    [Fact]
    public async Task The_dialog_is_absent_where_the_host_has_no_window()
    {
        using var factory = new PickerFactory(picker: null);

        var dialog = await factory.CreateClient()
            .GetFromJsonAsync<DialogResponse>("/api/connection/certificate-file");

        Assert.NotNull(dialog);
        Assert.False(dialog.CanChoose);
    }

    [Fact]
    public async Task The_dialog_is_there_where_the_host_owns_one()
    {
        using var factory = new PickerFactory(Returning(null));

        var dialog = await factory.CreateClient()
            .GetFromJsonAsync<DialogResponse>("/api/connection/certificate-file");

        Assert.True(dialog!.CanChoose);
    }

    // A run with no window registers no picker, and the console shows no button to press.
    [Fact]
    public async Task Choosing_is_not_implemented_where_the_host_has_no_window()
    {
        using var factory = new PickerFactory(picker: null);

        var response = await Choose(factory, "certificate");

        Assert.Equal(HttpStatusCode.NotImplemented, response.StatusCode);
    }

    [Fact]
    public async Task Choosing_reports_the_file_the_dialog_returned()
    {
        var file = TempFile();
        using var factory = new PickerFactory(Returning(file));

        var response = await Choose(factory, "certificate");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var chosen = await response.Content.ReadFromJsonAsync<FileResponse>();
        Assert.Equal(file, chosen!.Path);
    }

    // Dismissed is an answer rather than a failure, and the console leaves the box as it was.
    [Fact]
    public async Task A_dismissed_dialog_comes_back_as_no_path_rather_than_an_error()
    {
        using var factory = new PickerFactory(Returning(null));

        var response = await Choose(factory, "authority");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Null((await response.Content.ReadFromJsonAsync<FileResponse>())!.Path);
    }

    // The kind picks the dialog's title and its file-type menu, so all three have to arrive.
    [Theory]
    [InlineData("authority", "CA certificate")]
    [InlineData("certificate", "client certificate")]
    [InlineData("key", "private key")]
    public async Task Each_field_opens_a_dialog_named_for_itself(string kind, string said)
    {
        var picker = Returning(null);
        using var factory = new PickerFactory(picker);

        await Choose(factory, kind);

        await picker.Received(1).PickAsync(
            Arg.Is<string>(title => title != null && title.Contains(said)),
            Arg.Any<IReadOnlyList<FileFilter>>(),
            Arg.Any<CancellationToken>());
    }

    // A kind nobody defined must be answered rather than reaching the service: an out-of-range
    // enum arrives as whatever number was sent, and the switch below it throws.
    [Theory]
    [InlineData("""{"kind":"passwords"}""")]
    [InlineData("""{"kind":99}""")]
    [InlineData("{}")]
    public async Task A_field_nobody_defined_is_a_400_rather_than_a_500(string body)
    {
        using var factory = new PickerFactory(Returning(null));

        var response = await factory.CreateClient().PostAsync(
            "/api/connection/certificate-file",
            new StringContent(body, Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    private static Task<HttpResponseMessage> Choose(PickerFactory factory, string kind) =>
        factory.CreateClient().PostAsJsonAsync("/api/connection/certificate-file", new { kind });

    private static IFilePicker Returning(string? path)
    {
        var picker = Substitute.For<IFilePicker>();
        picker
            .PickAsync(Arg.Any<string>(), Arg.Any<IReadOnlyList<FileFilter>>(), Arg.Any<CancellationToken>())
            .Returns(path);

        return picker;
    }

    private static string TempFile()
    {
        var folder = Path.Combine(Path.GetTempPath(), $"mqttforge-cert-api-{Guid.NewGuid():N}");
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, "client.pfx");
        File.WriteAllText(path, "not really a certificate");

        return path;
    }

    private sealed record DialogResponse(bool CanChoose);

    private sealed record FileResponse(string? Path);

    /// <summary>
    /// The app with — or without — the one thing only a host that owns a window can supply. The
    /// ordinary factory registers no picker, which is the case a browser sees; the desktop shell
    /// is what registers one.
    /// </summary>
    private sealed class PickerFactory(IFilePicker? picker) : WebApplicationFactory<Program>
    {
        private readonly string _settingsPath =
            Path.Combine(Path.GetTempPath(), $"mqttforge-cert-api-{Guid.NewGuid():N}.json");

        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.ConfigureAppConfiguration((_, config) =>
                config.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["MqttForge:SettingsPath"] = _settingsPath,
                    ["MqttForge:ColourRulesPath"] = _settingsPath + ".colours"
                }));

            if (picker is not null)
                builder.ConfigureServices(services => services.AddSingleton(picker));
        }
    }
}
