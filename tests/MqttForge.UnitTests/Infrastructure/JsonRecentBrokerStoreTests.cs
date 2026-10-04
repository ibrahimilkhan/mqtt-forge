using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Persistence;
using Xunit;

namespace MqttForge.UnitTests.Infrastructure;

public class JsonRecentBrokerStoreTests : IDisposable
{
    private readonly string _path = Path.Combine(Path.GetTempPath(), $"mqttforge-{Guid.NewGuid():N}.json");

    private static readonly DateTimeOffset Noon = new(2026, 9, 12, 12, 0, 0, TimeSpan.Zero);

    private static BrokerConnectionSettings Settings(
        string host = "broker.example", int port = 1883, string clientId = "console") =>
        new(host, port, clientId, null, null, UseTls: false);

    [Fact]
    public async Task List_returns_empty_when_file_missing()
    {
        Assert.Empty(await new JsonRecentBrokerStore(_path).ListAsync(CancellationToken.None));
    }

    [Fact]
    public async Task The_newest_connection_is_at_the_front()
    {
        var store = new JsonRecentBrokerStore(_path);

        await store.RecordAsync(Settings("one.example"), Noon, CancellationToken.None);
        await store.RecordAsync(Settings("two.example"), Noon.AddMinutes(1), CancellationToken.None);

        var brokers = await store.ListAsync(CancellationToken.None);

        Assert.Equal(["two.example", "one.example"], brokers.Select(one => one.Settings.Host));
    }

    // Reconnecting to something already here is not a second broker.
    [Fact]
    public async Task Connecting_again_moves_the_row_forward_rather_than_writing_it_twice()
    {
        var store = new JsonRecentBrokerStore(_path);

        await store.RecordAsync(Settings("one.example"), Noon, CancellationToken.None);
        await store.RecordAsync(Settings("two.example"), Noon.AddMinutes(1), CancellationToken.None);
        await store.RecordAsync(Settings("one.example"), Noon.AddMinutes(2), CancellationToken.None);

        var brokers = await store.ListAsync(CancellationToken.None);

        Assert.Equal(["one.example", "two.example"], brokers.Select(one => one.Settings.Host));
        Assert.Equal(Noon.AddMinutes(2), brokers[0].LastConnectedAt);
    }

    // One card per broker. A second client ID is not a second broker on the card, and the row that
    // stays is the connection just made, not the one it replaced.
    [Fact]
    public async Task One_broker_under_two_client_ids_is_one_row_at_its_latest()
    {
        var store = new JsonRecentBrokerStore(_path);

        await store.RecordAsync(Settings(clientId: "console"), Noon, CancellationToken.None);
        await store.RecordAsync(Settings(clientId: "console-2"), Noon.AddMinutes(1), CancellationToken.None);

        var brokers = await store.ListAsync(CancellationToken.None);

        Assert.Single(brokers);
        Assert.Equal("console-2", brokers[0].Settings.ClientId);
        Assert.Equal(Noon.AddMinutes(1), brokers[0].LastConnectedAt);
    }

    [Fact]
    public async Task A_different_set_of_filters_on_one_broker_is_still_one_row()
    {
        var store = new JsonRecentBrokerStore(_path);

        await store.RecordAsync(Settings() with { Subscriptions = ["#"] }, Noon, CancellationToken.None);
        await store.RecordAsync(Settings() with { Subscriptions = ["plant/+/temp"] }, Noon.AddMinutes(1), CancellationToken.None);

        var brokers = await store.ListAsync(CancellationToken.None);

        Assert.Equal(["plant/+/temp"], Assert.Single(brokers).Settings.Subscriptions);
    }

    // A hostname does not care about case, so neither does the list.
    [Fact]
    public async Task A_host_typed_in_another_case_is_the_same_broker()
    {
        var store = new JsonRecentBrokerStore(_path);

        await store.RecordAsync(Settings("broker.example"), Noon, CancellationToken.None);
        await store.RecordAsync(Settings("Broker.Example"), Noon.AddMinutes(1), CancellationToken.None);

        Assert.Single(await store.ListAsync(CancellationToken.None));
    }

    // What the card draws is what makes two brokers different: another port, another scheme, or a
    // WebSocket on another path is another card.
    [Fact]
    public async Task Another_port_scheme_or_path_is_another_broker()
    {
        var store = new JsonRecentBrokerStore(_path);

        await store.RecordAsync(Settings(port: 1883), Noon, CancellationToken.None);
        await store.RecordAsync(Settings(port: 21883), Noon.AddMinutes(1), CancellationToken.None);
        await store.RecordAsync(Settings(port: 1883) with { UseTls = true }, Noon.AddMinutes(2), CancellationToken.None);
        await store.RecordAsync(
            Settings(port: 9001) with { Transport = MqttTransport.WebSocket, WebSocketPath = "/mqtt" },
            Noon.AddMinutes(3), CancellationToken.None);
        await store.RecordAsync(
            Settings(port: 9001) with { Transport = MqttTransport.WebSocket, WebSocketPath = "/ws" },
            Noon.AddMinutes(4), CancellationToken.None);

        Assert.Equal(5, (await store.ListAsync(CancellationToken.None)).Count);
    }

    // A file from before one broker meant one row, or one somebody edited, still reads with each
    // broker once — the newest of its rows, wherever in the file that row is. Asked both ways round,
    // because a collapse that kept whichever row came first would pass either one alone.
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task A_file_holding_one_broker_twice_reads_as_its_newest_row(bool newerFirstInFile)
    {
        var older = Row("older", Settings(clientId: "older"), Noon);
        var newer = Row("newer", Settings(clientId: "newer"), Noon.AddMinutes(1));
        var other = Row("other", Settings("other.example"), Noon.AddMinutes(5));

        await WriteRaw(newerFirstInFile ? [newer, other, older] : [older, other, newer]);

        var brokers = await new JsonRecentBrokerStore(_path).ListAsync(CancellationToken.None);

        Assert.Equal(["other.example", "broker.example"], brokers.Select(one => one.Settings.Host));
        Assert.Equal("newer", brokers[1].Settings.ClientId);
    }

    // All three parse, and the first thing done with any of them is to ask it for its endpoint. A row
    // with nowhere to go is dropped, and the rest of the file still reads — and still takes a write.
    // Written in the store's own spelling, PascalCase, so the good row beside each one is read.
    [Theory]
    [InlineData("""[null, {"Id":"ok","Settings":{"Host":"broker.example","Port":1883,"ClientId":"c","UseTls":false},"LastConnectedAt":"2026-09-12T12:00:00+00:00"}]""")]
    [InlineData("""[{"Id":"cut","LastConnectedAt":"2026-09-12T11:00:00+00:00"}, {"Id":"ok","Settings":{"Host":"broker.example","Port":1883,"ClientId":"c","UseTls":false},"LastConnectedAt":"2026-09-12T12:00:00+00:00"}]""")]
    [InlineData("""[{"Id":"blank","Settings":{"Host":"","Port":1883,"ClientId":"c","UseTls":false},"LastConnectedAt":"2026-09-12T11:00:00+00:00"}, {"Id":"ok","Settings":{"Host":"broker.example","Port":1883,"ClientId":"c","UseTls":false},"LastConnectedAt":"2026-09-12T12:00:00+00:00"}]""")]
    public async Task A_row_with_nowhere_to_go_is_dropped_rather_than_read(string file)
    {
        await File.WriteAllTextAsync(_path, file);
        var store = new JsonRecentBrokerStore(_path);

        Assert.Equal("ok", Assert.Single(await store.ListAsync(CancellationToken.None)).Id);

        await store.RecordAsync(Settings("other.example"), Noon.AddMinutes(1), CancellationToken.None);

        Assert.Equal(2, (await store.ListAsync(CancellationToken.None)).Count);
    }

    private static RecentBroker Row(string id, BrokerConnectionSettings settings, DateTimeOffset at) =>
        new(id, settings, at);

    // As the store writes it, so the rows read back exactly as a real file's would.
    private Task WriteRaw(IEnumerable<RecentBroker> rows) =>
        File.WriteAllTextAsync(_path, System.Text.Json.JsonSerializer.Serialize(rows,
            new System.Text.Json.JsonSerializerOptions
            {
                Converters =
                {
                    new System.Text.Json.Serialization.JsonStringEnumConverter(System.Text.Json.JsonNamingPolicy.CamelCase)
                }
            }));

    [Fact]
    public async Task Only_the_newest_are_kept()
    {
        var store = new JsonRecentBrokerStore(_path);

        for (var nth = 0; nth <= JsonRecentBrokerStore.Kept; nth++)
            await store.RecordAsync(Settings($"host-{nth}.example"), Noon.AddMinutes(nth), CancellationToken.None);

        var brokers = await store.ListAsync(CancellationToken.None);

        Assert.Equal(JsonRecentBrokerStore.Kept, brokers.Count);
        Assert.Equal($"host-{JsonRecentBrokerStore.Kept}.example", brokers[0].Settings.Host);
        Assert.DoesNotContain(brokers, one => one.Settings.Host == "host-0.example");
    }

    // This file is a convenience, not a credential store.
    [Fact]
    public async Task The_passwords_are_not_written()
    {
        var store = new JsonRecentBrokerStore(_path);
        var withSecrets = Settings() with
        {
            Password = "hunter2",
            Tls = new BrokerTlsSettings(ClientCertificatePassword: "keyfile")
        };

        await store.RecordAsync(withSecrets, Noon, CancellationToken.None);

        var kept = (await store.ListAsync(CancellationToken.None))[0];

        Assert.Null(kept.Settings.Password);
        Assert.Null(kept.Settings.Tls!.ClientCertificatePassword);
        Assert.DoesNotContain("hunter2", await File.ReadAllTextAsync(_path));
    }

    // A record read back has to still be itself, or forgetting one by id could never work.
    [Fact]
    public async Task The_id_survives_a_round_trip()
    {
        var store = new JsonRecentBrokerStore(_path);
        var withPassword = Settings() with { Password = "hunter2" };

        await store.RecordAsync(withPassword, Noon, CancellationToken.None);
        var kept = (await store.ListAsync(CancellationToken.None))[0];

        Assert.Equal(kept.Id, BrokerIdentity.Of(kept.Settings));
    }

    [Fact]
    public async Task Forget_drops_the_row_and_says_it_did()
    {
        var store = new JsonRecentBrokerStore(_path);
        await store.RecordAsync(Settings(), Noon, CancellationToken.None);
        var id = (await store.ListAsync(CancellationToken.None))[0].Id;

        Assert.True(await store.ForgetAsync(id, CancellationToken.None));
        Assert.Empty(await store.ListAsync(CancellationToken.None));
    }

    [Fact]
    public async Task Forgetting_something_that_is_not_here_says_so()
    {
        Assert.False(await new JsonRecentBrokerStore(_path).ForgetAsync("nothing", CancellationToken.None));
    }

    // Nothing here was typed on purpose, so a file nobody can read is no history and the next
    // connection writes a fresh one.
    [Fact]
    public async Task A_corrupt_file_reads_as_no_history()
    {
        await File.WriteAllTextAsync(_path, "{ this is not json");
        var store = new JsonRecentBrokerStore(_path);

        Assert.Empty(await store.ListAsync(CancellationToken.None));

        await store.RecordAsync(Settings(), Noon, CancellationToken.None);

        Assert.Single(await store.ListAsync(CancellationToken.None));
    }

    public void Dispose()
    {
        if (File.Exists(_path)) File.Delete(_path);
        GC.SuppressFinalize(this);
    }
}
