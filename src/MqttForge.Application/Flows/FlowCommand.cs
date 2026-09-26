using MqttForge.Domain.Models;

namespace MqttForge.Application.Flows;

/// <summary>Everything that can reach the flow engine's queue, as one closed union.</summary>
// One queue for all four, for AlertCommand's reason: order. A deploy posted after an arrival has to
// be applied after it, and a publish failure has to be counted against the flow that was running
// when it was asked for. The runtime is single-threaded, so this is also the whole list of ways any
// other thread is allowed to reach it.
public abstract record FlowCommand;

/// <summary>A message off the broker.</summary>
public sealed record FlowArrival(MqttMessage Message) : FlowCommand;

/// <summary>What should be running now, and every id still in the file.</summary>
public sealed record FlowDeploy(IReadOnlyList<CompiledFlow> Flows, IReadOnlyCollection<string> Kept) : FlowCommand;

/// <summary>Somebody pressed an Inject node's button.</summary>
public sealed record FlowInject(string FlowId, string NodeId) : FlowCommand;

/// <summary>The publish loop could not send what a Publish node asked for.</summary>
public sealed record FlowPublishFailed(string FlowId, string NodeId, string Reason) : FlowCommand;
