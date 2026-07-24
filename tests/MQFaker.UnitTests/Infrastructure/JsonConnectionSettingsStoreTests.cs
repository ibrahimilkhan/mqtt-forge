using MQFaker.Domain.Models;
using MQFaker.Infrastructure.Persistence;
using Xunit;

namespace MQFaker.UnitTests.Infrastructure;

public class JsonConnectionSettingsStoreTests : IDisposable
{
    private readonly string _path = Path.Combine(Path.GetTempPath(), $"mqfaker-{Guid.NewGuid():N}.json");

    [Fact]
    public async Task Load_returns_null_when_file_missing()
    {
        var store = new JsonConnectionSettingsStore(_path);

        var result = await store.LoadAsync(CancellationToken.None);

        Assert.Null(result);
    }

    [Fact]
    public async Task Save_then_Load_returns_same_settings()
    {
        var store = new JsonConnectionSettingsStore(_path);
        var settings = new BrokerConnectionSettings("broker.local", 8883, "client-1", "user", "pass", true);

        await store.SaveAsync(settings, CancellationToken.None);
        var loaded = await store.LoadAsync(CancellationToken.None);

        Assert.Equal(settings, loaded);
    }

    public void Dispose()
    {
        if (File.Exists(_path)) File.Delete(_path);
    }
}
