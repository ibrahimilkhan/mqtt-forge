using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Persistence;
using Xunit;

namespace MqttForge.UnitTests.Infrastructure;

public class JsonConnectionSettingsStoreTests : IDisposable
{
    private readonly string _path = Path.Combine(Path.GetTempPath(), $"mqttforge-{Guid.NewGuid():N}.json");

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

    /// <summary>
    /// The list of filters to subscribe on connect goes to disk with the rest.
    /// </summary>
    // It is the one thing in these settings the server never acts on — the console does its own
    // subscribing — so it would be the easy one to drop on the way through. Dropped, it is a
    // reader's list gone on the next reload.
    [Fact]
    public async Task Save_then_Load_keeps_the_subscription_list_in_order()
    {
        var store = new JsonConnectionSettingsStore(_path);
        var settings = new BrokerConnectionSettings(
            "broker.local", 1883, "client-1", null, null, false,
            Subscriptions: ["plant/+/temp", "$SYS/#"]);

        await store.SaveAsync(settings, CancellationToken.None);
        var loaded = await store.LoadAsync(CancellationToken.None);

        Assert.Equal(new[] { "plant/+/temp", "$SYS/#" }, loaded!.Subscriptions);
    }

    /// <summary>A settings file written before the list existed still reads.</summary>
    // Null is what it comes back as, and the console reads null as its old default of '#'. An
    // empty array would be a lie about what that reader asked for.
    [Fact]
    public async Task A_file_written_before_the_list_existed_loads_with_none()
    {
        await File.WriteAllTextAsync(
            _path,
            @"{""Host"":""broker.local"",""Port"":1883,""ClientId"":""c"",""Username"":null,
               ""Password"":null,""UseTls"":false,""Transport"":0,""ProtocolVersion"":0,
               ""WebSocketPath"":null,""CleanSession"":true,""SessionExpiryInterval"":null,
               ""Tls"":null}");

        var loaded = await new JsonConnectionSettingsStore(_path).LoadAsync(CancellationToken.None);

        Assert.NotNull(loaded);
        Assert.Null(loaded!.Subscriptions);
    }

    public void Dispose()
    {
        if (File.Exists(_path)) File.Delete(_path);
    }
}
