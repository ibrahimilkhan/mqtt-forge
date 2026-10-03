namespace MqttForge.Application.Flows;

/// <summary>One thing wrong with a flow, and where on the canvas it is.</summary>
public sealed record FlowProblem(string? NodeId, string? EdgeId, string Message)
{
    /// <summary>
    /// The address the console marks: <c>node:{id}</c>, <c>edge:{id}</c>, or <c>flow</c> for the
    /// flow as a whole. It is also the key the 400's <c>errors</c> map is written under.
    /// </summary>
    public string Key => NodeId is not null ? $"node:{NodeId}" : EdgeId is not null ? $"edge:{EdgeId}" : "flow";
}

/// <summary>A problem, and which flow in the file it belongs to.</summary>
public sealed record FlowSetProblem(string FlowId, FlowProblem Problem);
