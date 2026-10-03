namespace MqttForge.Application.Flows;

/// <summary>Which of a flow's two runs: the flow at work, or a test of its draft.</summary>
public enum FlowRunKind { Active, Test }

/// <summary>Where one of a flow's runs stands: the flow, and which of its two runs.</summary>
// A flow has at most one run of each kind at a time, so the flow and the kind name the run that stands
// there now, which is what the status, the alarms and the console go by. They do not name the run that
// stood there before it: an Update or a new Test puts a new run in the same place. So what comes back
// late for a step a run asked for — a publish that failed in the engine's loop, a webhook that never
// landed — names its run by the run's serial as well.
public readonly record struct FlowRunKey(string FlowId, FlowRunKind Kind);
