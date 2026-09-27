using MqttForge.Application.Alerts;
using MqttForge.Application.Flows;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Services;

/// <summary>What the flows page can ask for: the flows, a deploy, a delete, an inject.</summary>
// A deploy is three things that must not interleave with another deploy — write the file, compile
// what the file now holds, hand that to the engine — so they share one gate. Without it, two
// consoles deploying two flows at once could each compile the file as it stood before the other's
// write, and the engine would end up running whichever set arrived last: one flow short.
public sealed class FlowService
{
    private readonly IFlowStore _store;
    private readonly FlowEngine _engine;
    private readonly ILinkForRules _link;
    private readonly AlertEngineOptions _options;
    private readonly SemaphoreSlim _deploying = new(1, 1);

    public FlowService(IFlowStore store, FlowEngine engine, ILinkForRules link, AlertEngineOptions options)
    {
        _store = store;
        _engine = engine;
        _link = link;
        _options = options;
    }

    public async Task<FlowsView> GetAsync(CancellationToken ct)
    {
        var document = await _store.LoadAsync(ct);
        var set = FlowCompiler.CompileAll(document.Flows, _options.TopicPrefix);

        return new FlowsView(document.Flows, set.Problems, document.Unreadable, _options.AllowWebhooks, _options.TopicPrefix);
    }

    /// <summary>
    /// Keeps the flow and runs what the file now holds — or says why it will not. Answered once the
    /// engine is running it, or once <see cref="FlowEngine.DeployPatience"/> has passed without the
    /// engine getting to it; kept either way.
    /// </summary>
    public async Task<FlowSaveResult> SaveAsync(Flow flow, CancellationToken ct)
    {
        // Compiled before the gate: refusing a typo needs neither the file nor the engine.
        var compiled = FlowCompiler.Compile(flow, _options.TopicPrefix);
        if (compiled.Problems.Count > 0) return new FlowSaveResult(null, compiled.Problems);

        Task<bool> running;

        await _deploying.WaitAsync(ct);
        try
        {
            var document = await _store.LoadAsync(ct);
            if (document.Unreadable)
                throw new FlowsUnreadableException(
                    "The flows file could not be read, so nothing was deployed. Repair it or move it aside first.");

            if (document.Flows.All(one => one.Id != flow.Id) && document.Flows.Count >= FlowLimits.Flows)
                return new FlowSaveResult(null, [new FlowProblem(null, null, $"At most {FlowLimits.Flows} flows can be kept.")]);

            await _store.SaveAsync(flow, ct);
            running = _engine.DeployAsync(await DeploymentAsync(), ct);
        }
        finally
        {
            _deploying.Release();
        }

        // Waited for after the gate: the pump may be held up for a moment, and no other deploy has to
        // wait with it. What the answer means: the flows page presses a new Inject node's button the
        // moment Deploy comes back, and before the engine had the flow that was a 404.
        try
        {
            await running;
        }
        finally
        {
            // Asked whatever became of the wait, and with no token: the flow is written and runs whether
            // or not its client stayed for the answer, and a flow that runs needs the link. A dial can
            // take seconds, and no other deploy has to wait for it either. Only a host that dials at
            // start-up will dial here — see ILinkForRules.
            if (flow.Enabled) await _link.WantedAsync(CancellationToken.None);
        }

        return new FlowSaveResult(flow, []);
    }

    public async Task<bool> DeleteAsync(string id, CancellationToken ct)
    {
        Task<bool> running;

        await _deploying.WaitAsync(ct);
        try
        {
            if (!await _store.RemoveAsync(id, ct)) return false;

            running = _engine.DeployAsync(await DeploymentAsync(), ct);
        }
        finally
        {
            _deploying.Release();
        }

        await running;
        return true;
    }

    /// <summary>Presses a running flow's Inject node. False when no running flow has one by that id.</summary>
    public bool Inject(string flowId, string nodeId)
    {
        if (!_engine.CanInject(flowId, nodeId)) return false;

        _engine.Post(new FlowInject(flowId, nodeId));
        return true;
    }

    /// <summary>What the file holds now, compiled for the engine.</summary>
    // Read with no token, because it only ever follows a write. A client that went away once the write
    // had landed would otherwise leave its flow on disk and not running — or deleted and still running —
    // until the next deploy of anything or the next restart.
    private async Task<FlowDeploy> DeploymentAsync()
    {
        var document = await _store.LoadAsync(CancellationToken.None);
        var set = FlowCompiler.CompileAll(document.Flows, _options.TopicPrefix);

        return new FlowDeploy(set.Compiled, set.Kept);
    }
}

/// <summary>What GET /api/flows answers, before it is put on the wire.</summary>
public sealed record FlowsView(
    IReadOnlyList<Flow> Flows,
    IReadOnlyList<FlowSetProblem> Problems,
    bool Unreadable,
    bool AllowWebhooks,
    string AlertTopicPrefix);

/// <summary>A deploy's answer: the flow as kept, or why it was not.</summary>
public sealed record FlowSaveResult(Flow? Flow, IReadOnlyList<FlowProblem> Problems);
