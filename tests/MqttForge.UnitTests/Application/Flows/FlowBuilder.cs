using System.Text.Json;
using MqttForge.Application.Flows;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Flows;

/// <summary>A flow written the way a test reads: nodes by name, wires by port.</summary>
internal sealed class FlowBuilder
{
    public const string Prefix = "mqttforge/alerts/";

    private readonly string _id;
    private readonly string _name;
    private readonly List<FlowNode> _nodes = [];
    private readonly List<FlowEdge> _edges = [];
    private bool _enabled = true;

    public FlowBuilder(string id = "f1", string name = "Boiler watch")
    {
        _id = id;
        _name = name;
    }

    public FlowBuilder Node(string id, string type, object? config = null)
    {
        _nodes.Add(new FlowNode(id, type, 0, 0,
            JsonSerializer.SerializeToElement(config ?? new { }, FlowJson.Options)));
        return this;
    }

    public FlowBuilder Wire(string from, string fromPort, string to, string toPort)
    {
        _edges.Add(new FlowEdge($"e{_edges.Count + 1}", from, fromPort, to, toPort));
        return this;
    }

    public FlowBuilder Off()
    {
        _enabled = false;
        return this;
    }

    public Flow Build() => new(_id, _name, _enabled, [.. _nodes], [.. _edges]);

    public CompiledFlow Compile()
    {
        var result = FlowCompiler.Compile(Build(), Prefix);

        return result.Flow ?? throw new InvalidOperationException(
            "The test flow did not compile: " + string.Join(" / ", result.Problems.Select(p => $"{p.Key}: {p.Message}")));
    }
}
