using Microsoft.AspNetCore.Builder;
using MqttForge.Api;

namespace MqttForge.IntegrationTests.Api;

public sealed class HostConfigurationTests
{
    // No launchSettings.json in the published app; without a default, Kestrel falls back to
    // 5000 (macOS AirPlay's port).
    [Fact]
    public void Falls_back_to_5169_when_the_environment_names_no_binding()
    {
        var app = MqttForgeHost.Build([]);

        Assert.Equal(MqttForgeHost.DefaultUrls, app.Configuration["Urls"]);
    }

    // The default used to live in appsettings.json, which outranks the environment: both
    // variables a .NET user would reach for were silently dead, and the container said so in a
    // warning at every start.
    [Fact]
    public void Aspnetcore_urls_still_wins()
    {
        using var _ = new EnvironmentVariable("ASPNETCORE_URLS", "http://0.0.0.0:9191");

        var app = MqttForgeHost.Build([]);

        Assert.Equal("http://0.0.0.0:9191", app.Configuration["Urls"]);
    }

    [Fact]
    public void Aspnetcore_http_ports_is_left_alone_to_be_honoured()
    {
        using var _ = new EnvironmentVariable("ASPNETCORE_HTTP_PORTS", "9292");

        var app = MqttForgeHost.Build([]);

        // Kestrel expands HTTP_PORTS itself rather than writing it to Urls, so what matters is
        // that nothing pinned Urls over the top of it.
        Assert.Null(app.Configuration["Urls"]);
        Assert.Equal("9292", app.Configuration["HTTP_PORTS"]);
    }

    // The desktop shell picks its port at runtime and passes it in; that has to beat everything.
    [Fact]
    public void An_explicit_url_beats_the_environment()
    {
        using var _ = new EnvironmentVariable("ASPNETCORE_URLS", "http://0.0.0.0:9191");

        var app = MqttForgeHost.Build([], urls: "http://127.0.0.1:7777");

        Assert.Equal("http://127.0.0.1:7777", app.Configuration["Urls"]);
    }

    /// <summary>Sets a variable for one test and puts back whatever was there.</summary>
    private sealed class EnvironmentVariable : IDisposable
    {
        private readonly string _name;
        private readonly string? _previous;

        public EnvironmentVariable(string name, string value)
        {
            _name = name;
            _previous = Environment.GetEnvironmentVariable(name);
            Environment.SetEnvironmentVariable(name, value);
        }

        public void Dispose() => Environment.SetEnvironmentVariable(_name, _previous);
    }
}
