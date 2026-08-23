using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Persistence;
using Xunit;

namespace MqttForge.UnitTests.Infrastructure;

public class JsonSavedProfileStoreTests : IDisposable
{
    private readonly string _path = Path.Combine(Path.GetTempPath(), $"mqttforge-{Guid.NewGuid():N}.json");

    private static SavedBrokerProfile Profile(string name, string host = "broker.example", int port = 1883) =>
        new(name, new BrokerConnectionSettings(host, port, "console", null, null, UseTls: false));

    [Fact]
    public async Task List_returns_empty_when_file_missing()
    {
        Assert.Empty(await new JsonSavedProfileStore(_path).ListAsync(CancellationToken.None));
    }

    [Fact]
    public async Task Save_then_List_returns_what_was_saved()
    {
        var store = new JsonSavedProfileStore(_path);

        await store.SaveAsync(Profile("Lab broker"), CancellationToken.None);
        await store.SaveAsync(Profile("Staging", "mqtt.staging", 8883), CancellationToken.None);

        var profiles = await store.ListAsync(CancellationToken.None);

        Assert.Equal(["Lab broker", "Staging"], profiles.Select(one => one.Name));
        Assert.Equal(8883, profiles[1].Settings.Port);
    }

    // Somebody correcting a port on a broker they already saved presses Save again.
    [Fact]
    public async Task Saving_a_name_that_is_here_replaces_it_in_place()
    {
        var store = new JsonSavedProfileStore(_path);
        await store.SaveAsync(Profile("Lab broker", port: 1883), CancellationToken.None);
        await store.SaveAsync(Profile("Staging"), CancellationToken.None);

        await store.SaveAsync(Profile("Lab broker", port: 21883), CancellationToken.None);

        var profiles = await store.ListAsync(CancellationToken.None);

        Assert.Equal(2, profiles.Count);
        // In place, so the chips do not move under the hand correcting them.
        Assert.Equal("Lab broker", profiles[0].Name);
        Assert.Equal(21883, profiles[0].Settings.Port);
    }

    // A name is a label rather than a key.
    [Fact]
    public async Task A_name_matches_whatever_its_case()
    {
        var store = new JsonSavedProfileStore(_path);
        await store.SaveAsync(Profile("Lab broker", port: 1883), CancellationToken.None);

        await store.SaveAsync(Profile("LAB BROKER", port: 21883), CancellationToken.None);

        Assert.Equal(21883, Assert.Single(await store.ListAsync(CancellationToken.None)).Settings.Port);
    }

    [Fact]
    public async Task Delete_removes_it_and_says_it_did()
    {
        var store = new JsonSavedProfileStore(_path);
        await store.SaveAsync(Profile("Lab broker"), CancellationToken.None);
        await store.SaveAsync(Profile("Staging"), CancellationToken.None);

        Assert.True(await store.DeleteAsync("lab broker", CancellationToken.None));

        Assert.Equal("Staging", Assert.Single(await store.ListAsync(CancellationToken.None)).Name);
    }

    [Fact]
    public async Task Delete_says_so_when_there_was_nothing_under_that_name()
    {
        var store = new JsonSavedProfileStore(_path);

        Assert.False(await store.DeleteAsync("never saved", CancellationToken.None));
    }

    // Every setting a connection carries has to survive the round trip, not just the address:
    // a profile that lost its TLS block would connect somewhere other than where it was saved.
    [Fact]
    public async Task A_profile_keeps_everything_the_connection_had()
    {
        var store = new JsonSavedProfileStore(_path);
        var settings = new BrokerConnectionSettings(
            "abc.iot.example", 8883, "console", "alice", "hunter2", UseTls: true,
            Transport: MqttTransport.WebSocket,
            ProtocolVersion: MqttProtocolLevel.V500,
            WebSocketPath: "/mqtt",
            CleanSession: false,
            SessionExpiryInterval: 300,
            Tls: new BrokerTlsSettings(
                AllowUntrustedCertificates: true,
                CertificateAuthorityPath: "/etc/ca.crt",
                ClientCertificatePath: "/etc/client.pem",
                ClientCertificateKeyPath: "/etc/client.key",
                ClientCertificatePassword: "secret",
                SniHost: "sni.example",
                AlpnProtocol: "x-amzn-mqtt-ca"));

        await store.SaveAsync(new SavedBrokerProfile("Everything", settings), CancellationToken.None);

        var back = Assert.Single(await store.ListAsync(CancellationToken.None));

        Assert.Equal(settings, back.Settings);
    }

    // A file nobody can read is worth less than a clean start — the same call the two stores
    // beside this one make.
    [Fact]
    public async Task A_corrupt_file_reads_as_no_profiles()
    {
        await File.WriteAllTextAsync(_path, "{ this is not json");

        Assert.Empty(await new JsonSavedProfileStore(_path).ListAsync(CancellationToken.None));
    }

    public void Dispose()
    {
        if (File.Exists(_path)) File.Delete(_path);
        GC.SuppressFinalize(this);
    }
}
