using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using MQFaker.Api.Contracts;
using MQFaker.IntegrationTests.Support;
using Xunit;

namespace MQFaker.IntegrationTests.Api;

// A locked-down per-user data directory must not turn into a 500 for either endpoint
public class SettingsUnwritableTests : IClassFixture<MosquittoFixture>
{
    private readonly MosquittoFixture _broker;

    public SettingsUnwritableTests(MosquittoFixture broker) => _broker = broker;

    [Fact]
    public async Task Connect_succeeds_even_when_the_settings_directory_cannot_be_written()
    {
        if (OperatingSystem.IsWindows()) return;

        var directory = Directory.CreateTempSubdirectory("mqfaker-unwritable-");
        File.SetUnixFileMode(directory.FullName, UnixFileMode.UserRead | UnixFileMode.UserExecute);

        try
        {
            var settingsPath = Path.Combine(directory.FullName, "connection-settings.json");
            using var factory = new SettingsPathApiFactory(settingsPath);
            var client = factory.CreateClient();
            var connect = new ConnectRequestDto(_broker.Host, _broker.Port, "unwritable-test", null, null, false);

            var response = await client.PostAsJsonAsync("/api/connection", connect);

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }
        finally
        {
            File.SetUnixFileMode(directory.FullName, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            directory.Delete(recursive: true);
        }
    }

    [Fact]
    public async Task Saved_settings_endpoint_returns_no_content_instead_of_500_when_the_file_is_unreadable()
    {
        if (OperatingSystem.IsWindows()) return;

        var settingsPath = Path.Combine(Path.GetTempPath(), $"mqfaker-unreadable-{Guid.NewGuid():N}.json");
        await File.WriteAllTextAsync(settingsPath, "{}");
        File.SetUnixFileMode(settingsPath, UnixFileMode.None);

        try
        {
            using var factory = new SettingsPathApiFactory(settingsPath);
            var client = factory.CreateClient();

            var response = await client.GetAsync("/api/connection/settings");

            Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        }
        finally
        {
            File.Delete(settingsPath);
        }
    }

    // Same shape as MqFakerApiFactory, but the path is chosen by the test rather than random
    private sealed class SettingsPathApiFactory(string settingsPath) : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(IWebHostBuilder builder) =>
            builder.ConfigureAppConfiguration((_, config) =>
                config.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["MqFaker:SettingsPath"] = settingsPath
                }));
    }
}
