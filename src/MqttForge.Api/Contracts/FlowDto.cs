using MqttForge.Application.Flows;

namespace MqttForge.Api.Contracts;

/// <summary>What every running flow has done, as the hub pushes it and GET /api/flows/status answers.</summary>
public sealed record FlowStatusDto(IReadOnlyList<FlowRunStatusDto> Flows)
{
    public static FlowStatusDto Of(FlowStatus status) => new([.. status.Flows.Select(flow => new FlowRunStatusDto(
        flow.Id, flow.Faults, flow.Fault,
        [.. flow.Nodes.Select(node => new FlowNodeStatusDto(
            node.Id, node.Count, node.Outs, node.Errors, node.Note,
            [.. node.Standing.Select(standing => new FlowStandingDto(
                standing.Topic, standing.FiredAt, standing.Reason, standing.Count))]))]))]);
}

public sealed record FlowRunStatusDto(string Id, long Faults, string? Fault, IReadOnlyList<FlowNodeStatusDto> Nodes);

// Outs is written with its keys as they are — "yes", "sent", "raised" — because ASP.NET's naming
// policy renames properties and never dictionary keys, and the console reads them by those names.
public sealed record FlowNodeStatusDto(
    string Id, long Count, IReadOnlyDictionary<string, long> Outs, long Errors, string? Note,
    IReadOnlyList<FlowStandingDto> Standing);

public sealed record FlowStandingDto(string Topic, DateTimeOffset FiredAt, string Reason, int Count);

/// <summary>A line for the debug strip.</summary>
public sealed record FlowDebugDto(string FlowId, string NodeId, DateTimeOffset At, string Kind, string Topic, string Text)
{
    public static FlowDebugDto Of(FlowDebugEntry entry) =>
        new(entry.FlowId, entry.NodeId, entry.At, entry.Kind, entry.Topic, entry.Text);
}
