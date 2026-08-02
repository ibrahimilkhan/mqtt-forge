using MQFaker.Domain.Models;
using MQFaker.Infrastructure.Persistence;
using Xunit;

namespace MQFaker.UnitTests.Infrastructure;

public class JsonConnectionSettingsStoreResilienceTests : IDisposable
{
    private readonly string _path = Path.Combine(Path.GetTempPath(), $"mqfaker-res-{Guid.NewGuid():N}.json");

    [Fact]
    public async Task Load_returns_null_when_file_is_corrupt()
    {
        await File.WriteAllTextAsync(_path, "{ bu gecerli json degil ");
        var store = new JsonConnectionSettingsStore(_path);

        var result = await store.LoadAsync(CancellationToken.None);

        Assert.Null(result);
    }

    [Fact]
    public async Task Load_returns_null_when_file_permissions_deny_read()
    {
        if (OperatingSystem.IsWindows()) return;

        await File.WriteAllTextAsync(_path, "{}");
        File.SetUnixFileMode(_path, UnixFileMode.None);
        var store = new JsonConnectionSettingsStore(_path);

        var result = await store.LoadAsync(CancellationToken.None);

        Assert.Null(result);
    }

    [Fact]
    public async Task Save_leaves_no_temp_file_behind()
    {
        var store = new JsonConnectionSettingsStore(_path);

        await store.SaveAsync(new BrokerConnectionSettings("h", 1883, "c", null, null, false), CancellationToken.None);

        Assert.True(File.Exists(_path));
        Assert.False(File.Exists(_path + ".tmp"));
    }

    [Fact]
    public async Task Save_over_existing_file_replaces_content()
    {
        var store = new JsonConnectionSettingsStore(_path);
        await store.SaveAsync(new BrokerConnectionSettings("first", 1, "c", null, null, false), CancellationToken.None);

        await store.SaveAsync(new BrokerConnectionSettings("second", 2, "c", null, null, false), CancellationToken.None);

        var loaded = await store.LoadAsync(CancellationToken.None);
        Assert.Equal("second", loaded!.Host);
    }

    public void Dispose()
    {
        if (File.Exists(_path)) File.Delete(_path);
        if (File.Exists(_path + ".tmp")) File.Delete(_path + ".tmp");
    }
}
