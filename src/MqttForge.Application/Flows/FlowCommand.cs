using MqttForge.Domain.Models;

namespace MqttForge.Application.Flows;

/// <summary>Everything that can reach the flow engine's pump, as one closed union.</summary>
// One order for all of them, for AlertCommand's reason: a deploy posted after an arrival has to be
// applied after it. The runtime is single-threaded, so this is also the whole list of ways any other
// thread is allowed to reach it.
//
// A step that failed has to be counted against the run that was going when it was asked for, and no
// order can see to that on its own: the failure comes back after the turn that asked, when an Update
// or a new Test may have put another run in that one's place. So it names the run by its serial as
// well as its key, and the runtime lets it go when that run is gone.
//
// One queue for all but a deploy, which waits in a slot of its own because the queue drops its
// oldest entry when it is full, and takes its place in the queue's order by when it was posted.
// FlowEngine.Hand says the rest.
public abstract record FlowCommand;

/// <summary>A message off the broker.</summary>
public sealed record FlowArrival(MqttMessage Message) : FlowCommand;

/// <summary>What should be switched on now, and every id still in the file.</summary>
public sealed record FlowDeploy(IReadOnlyList<CompiledFlow> Flows, IReadOnlyCollection<string> Kept) : FlowCommand;

/// <summary>Somebody pressed Test: run this draft once, beside the flow's active run.</summary>
public sealed record FlowTestStart(CompiledFlow Flow) : FlowCommand;

/// <summary>Somebody pressed Stop on a test, or deleted the flow it was a test of.</summary>
public sealed record FlowTestStop(string FlowId) : FlowCommand;

/// <summary>The engine could not carry out a step a run asked for: a publish, a webhook post.</summary>
public sealed record FlowStepFailed(FlowRunKey Run, long Serial, string NodeId, string Reason) : FlowCommand;

/// <summary>Somebody cleared the alert history, which lists the flows' alarms that ended as well as the rules'.</summary>
public sealed record FlowClearHistory : FlowCommand;
