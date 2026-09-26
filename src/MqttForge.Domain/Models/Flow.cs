using System.Text.Json;

namespace MqttForge.Domain.Models;

/// <summary>
/// One flow as the editor drew it and the file keeps it: its nodes, where they stand, and the
/// wires that carry a message from one node's port to another's.
/// </summary>
// A node's settings stay JSON all the way down to the compiler. The store's only job is to keep
// what was deployed, and a store that had to understand every node type would refuse a whole file
// over one type a newer build wrote — the failure JsonAlertRuleStore spends forty lines avoiding.
// The compiler is the one place that knows what a setting means.
public sealed record Flow(
    string Id,
    string Name,
    bool Enabled,
    IReadOnlyList<FlowNode> Nodes,
    IReadOnlyList<FlowEdge> Edges);

/// <summary>A node: what kind it is, where it stands on the canvas, and its settings.</summary>
// X and Y belong to the editor. They are kept so the canvas comes back the way it was left, and
// nothing that runs a flow reads them — moving a node is not a change to what the flow does.
public sealed record FlowNode(string Id, string Type, double X, double Y, JsonElement Config);

/// <summary>A wire from one node's output port to another node's input port.</summary>
public sealed record FlowEdge(string Id, string From, string FromPort, string To, string ToPort);

/// <summary>What <c>flows.json</c> holds, and whether it could be read at all.</summary>
public sealed record FlowDocument(IReadOnlyList<Flow> Flows, bool Unreadable);
