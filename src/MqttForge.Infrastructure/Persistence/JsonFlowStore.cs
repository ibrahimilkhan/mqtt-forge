using System.Text.Json;
using MqttForge.Application.Flows;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;

namespace MqttForge.Infrastructure.Persistence;

// Write mechanics are JsonAlertRuleStore's — a temporary file, then a swap, so an interrupted write
// cannot leave half a document behind. The reading decision is that store's too: flows are a
// record, and calling a broken file "no flows" would stop everything that was running without a
// word and let the next deploy delete the lot.
//
// Unlike the rule store, the whole file is one verdict. A flow's settings are kept as JSON and the
// compiler reads them, so there is no per-item type for this store to fail to bind; what can go
// wrong is the envelope — a missing array, a missing id — and that is a truncated or hand-broken
// file, not one flow a newer build wrote.
public sealed class JsonFlowStore : IFlowStore
{
    // The envelope's only version so far. It exists so that the day the shape changes, the old
    // build meets a number it does not know rather than a document it half understands.
    public const int Version = 1;

    private readonly string _path;

    // Every write is read-modify-write, and two requests deploying two flows at once is the case
    // per-flow writes exist for. Without the gate the second read would miss the first write.
    private readonly SemaphoreSlim _gate = new(1, 1);

    public JsonFlowStore(string path) => _path = path;

    public async Task<FlowDocument> LoadAsync(CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            return await ReadAsync(ct);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task SaveAsync(Flow flow, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var document = await ReadAsync(ct);
            if (document.Unreadable) throw Unreadable();

            var flows = document.Flows.ToList();
            var at = flows.FindIndex(one => one.Id == flow.Id);

            if (at >= 0) flows[at] = flow;
            else flows.Add(flow);

            await WriteAsync(flows, ct);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<bool> RemoveAsync(string id, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var document = await ReadAsync(ct);
            if (document.Unreadable) throw Unreadable();

            var flows = document.Flows.Where(one => one.Id != id).ToList();
            if (flows.Count == document.Flows.Count) return false;

            await WriteAsync(flows, ct);
            return true;
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<FlowDocument> ReadAsync(CancellationToken ct)
    {
        // No file is not a fault. A first run has nothing to protect, and calling this unreadable
        // would lock every new install out of deploying its first flow.
        if (!File.Exists(_path)) return new FlowDocument([], Unreadable: false);

        FlowFile? file;
        try
        {
            await using var stream = File.OpenRead(_path);
            file = await JsonSerializer.DeserializeAsync<FlowFile>(stream, FlowJson.Options, ct);
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException or NotSupportedException)
        {
            return new FlowDocument([], Unreadable: true);
        }

        if (file is null || file.Version != Version || file.Flows is null)
            return new FlowDocument([], Unreadable: true);

        var flows = new List<Flow>(file.Flows.Count);
        foreach (var flow in file.Flows)
        {
            if (!Whole(flow)) return new FlowDocument([], Unreadable: true);

            // The one repair made on the way in: a node with no settings at all gets empty ones.
            // It is what Debug is written with by hand, and leaving it Undefined would make the
            // next write of this file throw.
            flows.Add(flow with
            {
                Nodes = [.. flow.Nodes.Select(node => node with { Config = FlowJson.OrEmpty(node.Config) })]
            });
        }

        return new FlowDocument(flows, Unreadable: false);
    }

    // The members STJ fills with null when the property is missing, even though the record says
    // they cannot be. A flow without them is not something to run or to write back.
    private static bool Whole(Flow? flow) =>
        flow is { Id: not null, Name: not null, Nodes: not null, Edges: not null } &&
        flow.Nodes.All(node => node is { Id: not null, Type: not null }) &&
        flow.Edges.All(edge => edge is { Id: not null, From: not null, FromPort: not null, To: not null, ToPort: not null });

    private async Task WriteAsync(IReadOnlyList<Flow> flows, CancellationToken ct)
    {
        var tempPath = _path + ".tmp";

        try
        {
            var directory = Path.GetDirectoryName(_path);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

            await using (var stream = File.Create(tempPath))
                await JsonSerializer.SerializeAsync(stream, new FlowFile(Version, flows), FlowJson.File, ct);

            File.Move(tempPath, _path, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new FlowsNotSavedException($"Could not write the flows to {_path}: {ex.Message}", ex);
        }
    }

    private FlowsUnreadableException Unreadable() => new(
        $"The flows file {_path} could not be read, so no flows are running. Repair it or move it " +
        "aside; nothing will be written over it until then.");

    // The envelope as a type, so the version is a property of the document rather than something
    // the writer has to remember to put in front of the array.
    private sealed record FlowFile(int Version, IReadOnlyList<Flow>? Flows);
}
