namespace MqttForge.Application.Flows.Next;

/// <summary>Which of a flow's two runs: the flow at work, or a test of its draft.</summary>
public enum FlowRunKind { Active, Test }

/// <summary>One run of one flow.</summary>
// A flow has at most one run of each kind, so the flow and the kind are the whole of a run's name:
// what a publish that failed in the engine's loop, or a webhook that never landed, says it belonged to.
public readonly record struct FlowRunKey(string FlowId, FlowRunKind Kind);
