using System.Text.Json;
using MqttForge.Application.Flows;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.Api.Contracts;

/// <summary>Every run there is, as the hub pushes it and GET /api/flows/status answers.</summary>
public sealed record FlowStatusDto(IReadOnlyList<FlowRunStatusDto> Runs)
{
    public static FlowStatusDto Of(FlowStatus status) => new([.. status.Runs.Select(run => new FlowRunStatusDto(
        run.FlowId, run.Kind, run.State, run.At,
        run.Waiting is { } waiting ? new FlowWaitingDto(waiting.Until, waiting.Filter) : null,
        run.Fault, run.Variables,
        [.. run.Nodes.Select(node => new FlowNodeStatusDto(
            node.Id, node.Count, node.Outs, node.Errors, node.Note,
            [.. node.Standing.Select(standing => new FlowStandingDto(
                standing.Topic, standing.FiredAt, standing.Reason, standing.Count))]))]))]);
}

// Variables is written with its keys as they are, like Outs below: ASP.NET's naming policy renames
// properties and never dictionary keys, and a variable is read by the name its flow gave it.
public sealed record FlowRunStatusDto(
    string FlowId, FlowRunKind Kind, FlowRunState State, string? At, FlowWaitingDto? Waiting, string? Fault,
    IReadOnlyDictionary<string, string> Variables, IReadOnlyList<FlowNodeStatusDto> Nodes);

public sealed record FlowWaitingDto(DateTimeOffset? Until, string? Filter);

// Outs is written with its keys as they are — "yes", "sent", "raised" — because ASP.NET's naming
// policy renames properties and never dictionary keys, and the console reads them by those names.
public sealed record FlowNodeStatusDto(
    string Id, long Count, IReadOnlyDictionary<string, long> Outs, long Errors, string? Note,
    IReadOnlyList<FlowStandingDto> Standing);

public sealed record FlowStandingDto(string Topic, DateTimeOffset FiredAt, string Reason, int Count);

/// <summary>A line for the debug strip, and whether a test's run printed it.</summary>
public sealed record FlowDebugDto(string FlowId, string NodeId, DateTimeOffset At, string Kind, string Topic, string Text, bool Test)
{
    public static FlowDebugDto Of(FlowDebugEntry entry) =>
        new(entry.FlowId, entry.NodeId, entry.At, entry.Kind, entry.Topic, entry.Text, entry.Test);
}

/// <summary>A tone a Sound node asked for.</summary>
public sealed record FlowSoundDto(string FlowId, string NodeId, AlertSeverity Level, bool Test)
{
    public static FlowSoundDto Of(FlowSound sound) => new(sound.FlowId, sound.NodeId, sound.Level, sound.Test);
}

/// <summary>A notice a Notify node asked for.</summary>
public sealed record FlowNoticeDto(
    string FlowId, string FlowName, string NodeId, string Text, AlertSeverity Level, DateTimeOffset At, bool Test)
{
    public static FlowNoticeDto Of(FlowNotice notice) =>
        new(notice.FlowId, notice.FlowName, notice.NodeId, notice.Text, notice.Level, notice.At, notice.Test);
}

/// <summary>One flow on the wire: the file's shape, one for one.</summary>
// Every member nullable, on purpose. [ApiController] treats a non-nullable reference as [Required]
// and answers a missing one with its own 400 before the controller runs — a different shape from
// every other refusal a deploy can meet. Here a missing name is simply an empty one, and the
// compiler says so in the same sentence-per-node form as everything else.
public sealed record FlowDto(
    string? Id, string? Name, bool Enabled, IReadOnlyList<FlowNodeDto>? Nodes, IReadOnlyList<FlowEdgeDto>? Edges,
    IReadOnlyList<FlowVariableDto>? Variables = null)
{
    // A node or edge in the array can itself be JSON null — STJ allows a hole in the middle of an
    // array same as it allows the array to be missing — and FlowCompiler already turns that into
    // its own flow-level problem ("A node in this flow is empty." / "A wire in this flow is
    // empty."). So a null here is passed through as a null rather than dereferenced, and the
    // compiler is left to say why it is refused, the same way it says why any other node is. A
    // variable missing its name or value has an empty one, which the compiler refuses by name.
    public Flow ToFlow() => new(
        Id ?? "", Name ?? "", Enabled,
        [.. (Nodes ?? []).Select(node => node is null ? null! : new FlowNode(
            node.Id ?? "", node.Type ?? "", node.X, node.Y, FlowJson.OrEmpty(node.Config)))],
        [.. (Edges ?? []).Select(edge => edge is null ? null! : new FlowEdge(
            edge.Id ?? "", edge.From ?? "", edge.FromPort ?? "", edge.To ?? "", edge.ToPort ?? ""))])
    {
        Variables = [.. (Variables ?? []).Select(variable => new FlowVariable(variable?.Name ?? "", variable?.Value ?? ""))],
    };

    public static FlowDto Of(Flow flow) => new(
        flow.Id, flow.Name, flow.Enabled,
        [.. flow.Nodes.Select(node => new FlowNodeDto(node.Id, node.Type, node.X, node.Y, node.Config))],
        [.. flow.Edges.Select(edge => new FlowEdgeDto(edge.Id, edge.From, edge.FromPort, edge.To, edge.ToPort))],
        [.. flow.Variables.Select(variable => new FlowVariableDto(variable.Name, variable.Value))]);
}

public sealed record FlowNodeDto(string? Id, string? Type, double X, double Y, JsonElement Config);

public sealed record FlowEdgeDto(string? Id, string? From, string? FromPort, string? To, string? ToPort);

public sealed record FlowVariableDto(string? Name, string? Value);

/// <summary>A problem with a flow in the file, under the key the console marks.</summary>
public sealed record FlowProblemDto(string FlowId, string Key, string Message);

/// <summary>GET /api/flows: the flows, what is wrong with any of them, and two facts about this host.</summary>
public sealed record FlowsDto(
    IReadOnlyList<FlowDto> Flows,
    IReadOnlyList<FlowProblemDto> Problems,
    bool Unreadable,
    bool AllowWebhooks,
    string AlertTopicPrefix);

/// <summary>A deploy that went through, with the flow as it was kept.</summary>
public sealed record FlowSavedDto(FlowDto Flow);
