using System.Text.Json;
using MqttForge.Application.Flows.Next;
using MqttForge.Domain.Models;
using FlowJson = MqttForge.Application.Flows.FlowJson;

namespace MqttForge.UnitTests.Application.Flows.Next;

/// <summary>A flowchart written the way a test reads: nodes by id, wires by port.</summary>
internal sealed class ChartBuilder
{
    public const string Prefix = "mqttforge/alerts/";

    private readonly string _id;
    private readonly string _name;
    private readonly List<FlowNode> _nodes = [];
    private readonly List<FlowEdge> _edges = [];
    private readonly List<FlowVariable> _variables = [];
    private bool _enabled = true;

    public ChartBuilder(string id = "f1", string name = "Boiler watch")
    {
        _id = id;
        _name = name;
    }

    public ChartBuilder Node(string id, string type, object? config = null)
    {
        _nodes.Add(new FlowNode(id, type, 0, 0, JsonSerializer.SerializeToElement(config ?? new { }, FlowJson.Options)));
        return this;
    }

    public ChartBuilder Wire(string from, string fromPort, string to, string toPort = "in")
    {
        _edges.Add(new FlowEdge($"e{_edges.Count + 1}", from, fromPort, to, toPort));
        return this;
    }

    /// <summary>Each node's one way out to the next node's way in, in the order given.</summary>
    public ChartBuilder Then(params string[] ids)
    {
        for (var i = 0; i + 1 < ids.Length; i++) Wire(ids[i], "out", ids[i + 1]);
        return this;
    }

    public ChartBuilder Var(string name, string value)
    {
        _variables.Add(new FlowVariable(name, value));
        return this;
    }

    public ChartBuilder Off()
    {
        _enabled = false;
        return this;
    }

    public Flow Build() => new(_id, _name, _enabled, [.. _nodes], [.. _edges]) { Variables = [.. _variables] };

    public CompiledFlow Compile()
    {
        var result = FlowCompiler.Compile(Build(), Prefix);

        return result.Flow ?? throw new InvalidOperationException(
            "The test flow did not compile: " + string.Join(" / ", result.Problems.Select(p => $"{p.Key}: {p.Message}")));
    }
}
