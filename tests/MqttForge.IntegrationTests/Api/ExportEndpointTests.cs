using System.Net;
using System.Net.Http.Json;
using System.Text;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using MqttForge.Application.Services;
using MqttForge.Domain.Abstractions;
using NSubstitute;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

/// <summary>
/// The one endpoint that writes to the disk of the machine it runs on.
///
/// The folder is never taken from the caller — it can only be set by the host's own dialog — and
/// the name is reduced to a bare leaf, so what a stranger on the network can do here is bounded by
/// a folder its owner already opened. That is the whole of the reasoning on ExportService, and
/// nothing was checking it end to end.
/// </summary>
public sealed class ExportEndpointTests
{
    [Fact]
    public async Task Folder_says_this_host_cannot_be_asked_when_it_has_no_window()
    {
        using var factory = new ExportFactory(picker: null);

        var folder = await factory.CreateClient().GetFromJsonAsync<FolderResponse>("/api/export/folder");

        Assert.NotNull(folder);
        Assert.Null(folder.Folder);
        Assert.False(folder.CanChoose);
    }

    // A run with no window registers no picker, and the interface falls back to a download.
    [Fact]
    public async Task Choosing_is_not_implemented_where_the_host_has_no_window()
    {
        using var factory = new ExportFactory(picker: null);

        var response = await factory.CreateClient().PostAsync("/api/export/folder", null);

        Assert.Equal(HttpStatusCode.NotImplemented, response.StatusCode);
    }

    [Fact]
    public async Task Choosing_reports_the_folder_the_dialog_returned()
    {
        var chosen = TempFolder();
        using var factory = new ExportFactory(PickerReturning(chosen));

        var response = await factory.CreateClient().PostAsync("/api/export/folder", null);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var folder = await response.Content.ReadFromJsonAsync<FolderResponse>();
        Assert.Equal(chosen, folder!.Folder);
        Assert.True(folder.CanChoose);
    }

    [Fact]
    public async Task Saving_before_a_folder_is_chosen_is_a_conflict_rather_than_a_500()
    {
        using var factory = new ExportFactory(picker: null);

        var response = await Save(factory, "readings", "a,b\n1,2\n");

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
    }

    [Fact]
    public async Task Saving_writes_the_file_and_says_where_it_landed()
    {
        var chosen = TempFolder();
        using var factory = new ExportFactory(PickerReturning(chosen));
        var client = factory.CreateClient();
        await client.PostAsync("/api/export/folder", null);

        var response = await Save(factory, "sensors/room/temp", "at,value\n1,2\n", client);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var saved = await response.Content.ReadFromJsonAsync<SavedResponse>();
        Assert.Equal(Path.Combine(chosen, "sensors-room-temp.csv"), saved!.Path);
        Assert.Equal("at,value\n1,2\n", await File.ReadAllTextAsync(saved.Path));
    }

    // The name is reduced to a bare leaf before it is joined to the folder, so a caller cannot
    // climb out of the folder its owner opened.
    [Theory]
    [InlineData("../../etc/passwd")]
    [InlineData("/etc/passwd")]
    [InlineData("..\\..\\windows\\system32\\config")]
    public async Task Saving_cannot_climb_out_of_the_chosen_folder(string name)
    {
        var chosen = TempFolder();
        using var factory = new ExportFactory(PickerReturning(chosen));
        var client = factory.CreateClient();
        await client.PostAsync("/api/export/folder", null);

        var response = await Save(factory, name, "a\n", client);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var saved = await response.Content.ReadFromJsonAsync<SavedResponse>();
        Assert.Equal(chosen, Path.GetDirectoryName(saved!.Path));
    }

    [Fact]
    public async Task Saving_more_than_the_cap_is_refused()
    {
        var chosen = TempFolder();
        using var factory = new ExportFactory(PickerReturning(chosen));
        var client = factory.CreateClient();
        await client.PostAsync("/api/export/folder", null);

        var response = await Save(
            factory, "readings", new string('x', ExportService.LargestExport + 1), client);

        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
    }

    // A body with the fields missing must be answered rather than reaching the service and coming
    // back as a 500: this is the only DTO with no validator of its own.
    [Theory]
    [InlineData("{}")]
    [InlineData("""{"name":"readings"}""")]
    [InlineData("""{"content":"a,b\n"}""")]
    public async Task Saving_without_the_fields_is_a_400_rather_than_a_500(string body)
    {
        var chosen = TempFolder();
        using var factory = new ExportFactory(PickerReturning(chosen));
        var client = factory.CreateClient();
        await client.PostAsync("/api/export/folder", null);

        var response = await client.PostAsync(
            "/api/export/csv", new StringContent(body, Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    private static Task<HttpResponseMessage> Save(
        ExportFactory factory, string name, string content, HttpClient? client = null) =>
        (client ?? factory.CreateClient()).PostAsJsonAsync("/api/export/csv", new { name, content });

    private static IFolderPicker PickerReturning(string folder)
    {
        var picker = Substitute.For<IFolderPicker>();
        picker.PickAsync(Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(folder);

        return picker;
    }

    private static string TempFolder()
    {
        var path = Path.Combine(Path.GetTempPath(), $"mqttforge-export-api-{Guid.NewGuid():N}");
        Directory.CreateDirectory(path);

        return path;
    }

    private sealed record FolderResponse(string? Folder, bool CanChoose);

    private sealed record SavedResponse(string Path);

    /// <summary>
    /// The app with — or without — the one thing only a host that owns a window can supply. The
    /// ordinary factory registers no picker, which is the case a browser sees; the desktop shell
    /// is what registers one.
    /// </summary>
    private sealed class ExportFactory(IFolderPicker? picker) : WebApplicationFactory<Program>
    {
        private readonly string _settingsPath =
            Path.Combine(Path.GetTempPath(), $"mqttforge-export-api-{Guid.NewGuid():N}.json");

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
