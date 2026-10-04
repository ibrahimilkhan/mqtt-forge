using System.Text.Json;
using System.Text.Json.Serialization;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;

namespace MqttForge.Infrastructure.Persistence;

public sealed class JsonRecentBrokerStore : IRecentBrokerStore
{
    /// <summary>
    /// How many are kept. The list stands above the saved brokers in one panel, and a history
    /// longer than the thing it sits over would read as the main list.
    /// </summary>
    public const int Kept = 8;

    // Enums as names, matching the two settings files beside it: these are files people open when
    // a connection will not come back, and "transport": "webSocket" answers a question there that
    // a 1 only raises.
    private static readonly JsonSerializerOptions Format = new()
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
        WriteIndented = true
    };

    private readonly string _filePath;

    // One writer at a time. Record and Forget are both read-modify-write over the whole list, and
    // two of them at once would lose one of the two edits — two consoles connecting at the same
    // moment is exactly the case this file exists for.
    private readonly SemaphoreSlim _gate = new(1, 1);

    public JsonRecentBrokerStore(string filePath) => _filePath = filePath;

    // A file nobody can read is treated as no history. Unlike the saved brokers, nothing here was
    // typed on purpose: this list is written by connecting and is rebuilt by connecting again, so
    // losing it costs a reader the trouble of retyping an address rather than the only copy of
    // something they chose.
    public async Task<IReadOnlyList<RecentBroker>> ListAsync(CancellationToken ct)
    {
        if (!File.Exists(_filePath)) return [];

        try
        {
            await using var stream = File.OpenRead(_filePath);
            var brokers = await JsonSerializer.DeserializeAsync<List<RecentBroker?>>(stream, Format, ct);

            // A file holding 'null' parses but carries no list. Collapsed on the way out as well as
            // on the way in, so a file written before one broker meant one row — or edited by
            // hand — still reads as a list with each broker in it once, at its latest.
            return Newest(brokers ?? []);
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }

    public async Task RecordAsync(BrokerConnectionSettings settings, DateTimeOffset at, CancellationToken ct)
    {
        var id = BrokerIdentity.Of(settings);

        await _gate.WaitAsync(ct);
        try
        {
            var brokers = (await ListAsync(ct)).ToList();

            // Reconnecting to a broker already here is not a second broker, whatever else changed
            // about the connection. One row per endpoint — scheme, host, port and WebSocket path,
            // which is what the card draws — and the row that stays is this one, with the client
            // ID and filters just used: two rows reading `broker.hivemq.com mqtts` that differed
            // only in a field the card does not show were two cards nobody could tell apart.
            //
            // Dropped and written again at the front, because unlike the saved list — whose chips
            // must not move under the hand correcting them — this one is ordered by exactly the
            // fact that just changed.
            brokers.RemoveAll(one => SameEndpoint(one.Settings, settings));

            // Without the password. This file is a convenience, not a credential store, and
            // nothing that reads it is allowed to see one anyway.
            brokers.Insert(0, new RecentBroker(id, Forgotten(settings), at));

            if (brokers.Count > Kept) brokers.RemoveRange(Kept, brokers.Count - Kept);

            await WriteAsync(brokers, ct);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<bool> ForgetAsync(string id, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var brokers = (await ListAsync(ct)).ToList();
            if (brokers.RemoveAll(one => one.Id == id) == 0) return false;

            await WriteAsync(brokers, ct);
            return true;
        }
        finally
        {
            _gate.Release();
        }
    }

    // Newest first, each endpoint once. Stable on ties, so rows written in the same instant keep
    // the order the file gave them.
    //
    // A row that is null, or carries no settings or no host, is dropped rather than read. Both parse
    // — `[null]`, or a row somebody cut the settings out of — and the first thing done with either
    // is to ask it for its endpoint, which threw past every catch above: the list answered 500, and
    // every connect after it did too, for a link that had come up. A row with nowhere to go is not
    // a broker anybody can press.
    private static List<RecentBroker> Newest(IEnumerable<RecentBroker?> brokers)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        return brokers
            .OfType<RecentBroker>()
            .Where(one => one.Settings is not null && !string.IsNullOrWhiteSpace(one.Settings.Host))
            .OrderByDescending(one => one.LastConnectedAt)
            .Where(one => seen.Add(one.Settings.Endpoint))
            .ToList();
    }

    // The endpoint as the rest of the app writes it, compared without regard to case: a hostname
    // is case-insensitive, and `Broker.HiveMQ.com` typed once is the broker reached yesterday.
    private static bool SameEndpoint(BrokerConnectionSettings a, BrokerConnectionSettings b) =>
        string.Equals(a.Endpoint, b.Endpoint, StringComparison.OrdinalIgnoreCase);

    // The two secrets dropped, and the TLS block kept as null where it was null — a connection
    // that never touched that section must not come back as one that set it all to its defaults,
    // which is a different identity.
    private static BrokerConnectionSettings Forgotten(BrokerConnectionSettings settings) =>
        settings with
        {
            Password = null,
            Tls = settings.Tls is null ? null : settings.Tls with { ClientCertificatePassword = null }
        };

    // Writes to a temp file then swaps in, so an interrupted write cannot corrupt the existing
    // one. The same discipline as the stores beside it.
    private async Task WriteAsync(IReadOnlyList<RecentBroker> brokers, CancellationToken ct)
    {
        var directory = Path.GetDirectoryName(_filePath);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

        var tempPath = _filePath + ".tmp";
        await using (var stream = File.Create(tempPath))
        {
            await JsonSerializer.SerializeAsync(stream, brokers, Format, ct);
        }

        File.Move(tempPath, _filePath, overwrite: true);
    }
}
