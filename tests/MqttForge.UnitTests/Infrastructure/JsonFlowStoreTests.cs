using System.Text.Json;
using MqttForge.Application.Flows;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Persistence;

namespace MqttForge.UnitTests.Infrastructure;

public sealed class JsonFlowStoreTests : IDisposable
{
    private readonly string _path =
        Path.Combine(Path.GetTempPath(), $"mqttforge-flows-{Guid.NewGuid():N}.json");

    public void Dispose()
    {
        if (File.Exists(_path)) File.Delete(_path);
        if (File.Exists(_path + ".tmp")) File.Delete(_path + ".tmp");
    }

    private static Flow Watch(string id = "watch", string name = "Boiler watch") => new(
        id, name, Enabled: true,
        [
            new FlowNode("n1", "mqttIn", 40, 120,
                JsonSerializer.SerializeToElement(new { filter = "plant/+/temp" }, FlowJson.Options)),
            new FlowNode("n2", "debug", 260, 120, FlowJson.EmptyConfig),
        ],
        [new FlowEdge("e1", "n1", "out", "n2", "in")]);

    [Fact]
    public async Task No_file_is_an_empty_readable_document()
    {
        var document = await new JsonFlowStore(_path).LoadAsync(CancellationToken.None);

        Assert.False(document.Unreadable);
        Assert.Empty(document.Flows);
    }

    [Fact]
    public async Task A_saved_flow_comes_back_as_it_went_in()
    {
        var store = new JsonFlowStore(_path);

        await store.SaveAsync(Watch(), CancellationToken.None);
        var flow = Assert.Single((await store.LoadAsync(CancellationToken.None)).Flows);

        Assert.Equal("watch", flow.Id);
        Assert.Equal("Boiler watch", flow.Name);
        Assert.True(flow.Enabled);
        Assert.Equal(2, flow.Nodes.Count);
        Assert.Equal(40, flow.Nodes[0].X);
        Assert.Equal(120, flow.Nodes[0].Y);
        Assert.Equal("plant/+/temp", flow.Nodes[0].Config.GetProperty("filter").GetString());
        Assert.Equal(new FlowEdge("e1", "n1", "out", "n2", "in"), Assert.Single(flow.Edges));
    }

    [Fact]
    public async Task Saving_a_flow_with_a_known_id_replaces_it_in_place()
    {
        var store = new JsonFlowStore(_path);
        await store.SaveAsync(Watch("a", "First"), CancellationToken.None);
        await store.SaveAsync(Watch("b", "Second"), CancellationToken.None);

        await store.SaveAsync(Watch("a", "First, renamed"), CancellationToken.None);

        var flows = (await store.LoadAsync(CancellationToken.None)).Flows;
        Assert.Equal(["a", "b"], flows.Select(flow => flow.Id));
        Assert.Equal("First, renamed", flows[0].Name);
    }

    [Fact]
    public async Task Removing_takes_one_flow_out_and_says_whether_it_was_there()
    {
        var store = new JsonFlowStore(_path);
        await store.SaveAsync(Watch("a"), CancellationToken.None);
        await store.SaveAsync(Watch("b"), CancellationToken.None);

        Assert.True(await store.RemoveAsync("a", CancellationToken.None));
        Assert.False(await store.RemoveAsync("nope", CancellationToken.None));

        Assert.Equal(["b"], (await store.LoadAsync(CancellationToken.None)).Flows.Select(flow => flow.Id));
    }

    [Theory]
    [InlineData("not json at all")]
    [InlineData("{\"version\":2,\"flows\":[]}")]
    [InlineData("{\"version\":1}")]
    [InlineData("{\"version\":1,\"flows\":[{\"id\":\"a\",\"name\":\"A\",\"enabled\":true,\"edges\":[]}]}")]
    public async Task A_file_this_build_cannot_read_is_unreadable_and_is_not_written_over(string content)
    {
        await File.WriteAllTextAsync(_path, content);
        var store = new JsonFlowStore(_path);

        Assert.True((await store.LoadAsync(CancellationToken.None)).Unreadable);
        await Assert.ThrowsAsync<FlowsUnreadableException>(() => store.SaveAsync(Watch(), CancellationToken.None));
        await Assert.ThrowsAsync<FlowsUnreadableException>(() => store.RemoveAsync("watch", CancellationToken.None));

        Assert.Equal(content, await File.ReadAllTextAsync(_path));
    }

    [Fact]
    public async Task A_node_written_without_settings_reads_as_empty_settings()
    {
        await File.WriteAllTextAsync(_path,
            "{\"version\":1,\"flows\":[{\"id\":\"a\",\"name\":\"A\",\"enabled\":true," +
            "\"nodes\":[{\"id\":\"n1\",\"type\":\"debug\",\"x\":0,\"y\":0}],\"edges\":[]}]}");

        var node = Assert.Single(Assert.Single((await new JsonFlowStore(_path).LoadAsync(CancellationToken.None)).Flows).Nodes);

        Assert.Equal(JsonValueKind.Object, node.Config.ValueKind);
    }

    [Fact]
    public async Task A_write_leaves_no_temporary_file_behind()
    {
        await new JsonFlowStore(_path).SaveAsync(Watch(), CancellationToken.None);

        Assert.True(File.Exists(_path));
        Assert.False(File.Exists(_path + ".tmp"));
    }

    [Fact]
    public async Task A_place_that_cannot_be_written_to_is_said_as_flows_not_saved()
    {
        // A directory where the file should be: File.Create on it fails on every platform.
        Directory.CreateDirectory(_path + ".tmp");
        try
        {
            await Assert.ThrowsAsync<FlowsNotSavedException>(
                () => new JsonFlowStore(_path).SaveAsync(Watch(), CancellationToken.None));
        }
        finally
        {
            Directory.Delete(_path + ".tmp");
        }
    }

    [Fact]
    public async Task A_flows_variables_come_back_with_it()
    {
        var store = new JsonFlowStore(_path);

        await store.SaveAsync(Watch() with { Variables = [new FlowVariable("limit", "90"), new FlowVariable("sensors", "[\"k1\"]")] },
            CancellationToken.None);

        var flow = Assert.Single((await store.LoadAsync(CancellationToken.None)).Flows);
        Assert.Equal([new FlowVariable("limit", "90"), new FlowVariable("sensors", "[\"k1\"]")], flow.Variables);
    }

    // Written before variables existed, or by hand: no list at all is no variables, and so is null.
    [Theory]
    [InlineData("")]
    [InlineData(""", "variables": null""")]
    public async Task A_flow_without_a_variables_list_has_none(string variables)
    {
        await File.WriteAllTextAsync(_path,
            $$"""{ "version": 1, "flows": [ { "id": "f1", "name": "F", "enabled": true, "nodes": [], "edges": [] {{variables}} } ] }""");

        var document = await new JsonFlowStore(_path).LoadAsync(CancellationToken.None);

        Assert.False(document.Unreadable);
        Assert.Empty(Assert.Single(document.Flows).Variables);
    }

    // An escaped half of a surrogate pair is valid JSON and no text, and a hand-edited file can hold one in
    // a node's settings, which the store keeps as the JSON they are. Every save writes the whole file back,
    // and the serializer cannot write such text, so taken as readable the file would fail every later save
    // of every flow for as long as it held it. Taken as unreadable, it is refused once and left alone.
    [Fact]
    public async Task A_node_setting_that_holds_text_that_cannot_be_read_makes_the_file_unreadable_and_it_is_not_written_over()
    {
        const string content = """
            { "version": 1, "flows": [ { "id": "f1", "name": "F", "enabled": true,
              "nodes": [ { "id": "n1", "type": "debug", "x": 0, "y": 0, "config": { "note": "\ud800" } } ], "edges": [] } ] }
            """;
        await File.WriteAllTextAsync(_path, content);
        var store = new JsonFlowStore(_path);

        Assert.True((await store.LoadAsync(CancellationToken.None)).Unreadable);
        await Assert.ThrowsAsync<FlowsUnreadableException>(() => store.SaveAsync(Watch(), CancellationToken.None));

        Assert.Equal(content, await File.ReadAllTextAsync(_path));
    }

    [Fact]
    public async Task A_variable_without_a_name_makes_the_file_unreadable()
    {
        await File.WriteAllTextAsync(_path,
            """{ "version": 1, "flows": [ { "id": "f1", "name": "F", "enabled": true, "nodes": [], "edges": [], "variables": [ { "value": "1" } ] } ] }""");

        Assert.True((await new JsonFlowStore(_path).LoadAsync(CancellationToken.None)).Unreadable);
    }
}
