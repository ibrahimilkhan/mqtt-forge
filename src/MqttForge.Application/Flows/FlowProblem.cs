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

/// <summary>What compiling one flow came to.</summary>
public sealed record FlowCompileResult(CompiledFlow? Flow, IReadOnlyList<FlowProblem> Problems);

/// <summary>Every flow in a file, compiled: what can run, every id, and what could not compile.</summary>
public sealed record FlowSet(
    IReadOnlyList<CompiledFlow> Compiled,
    IReadOnlyList<string> Kept,
    IReadOnlyList<FlowSetProblem> Problems);

/// <summary>A problem, and which flow in the file it belongs to.</summary>
public sealed record FlowSetProblem(string FlowId, FlowProblem Problem);
