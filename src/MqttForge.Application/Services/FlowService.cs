using MqttForge.Application.Alerts;
using MqttForge.Application.Flows;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Services;

/// <summary>What the flows page can ask for: the flows, a save, a delete, a test and its stop.</summary>
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
            // A file that cannot be read is the store's to refuse, on the write below.
            var document = await _store.LoadAsync(ct);
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
        // wait with it. What the answer means: by the time Activate or Update comes back, the engine runs
        // what was saved — FlowEngine.IsActive says so, and the next push shows it.
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

    /// <summary>
    /// Takes the flow out of the file and stops it, and takes its test away. False when the file did not
    /// have it; its test is taken away all the same.
    /// </summary>
    public async Task<bool> DeleteAsync(string id, CancellationToken ct)
    {
        Task<bool>? running = null;

        await _deploying.WaitAsync(ct);
        try
        {
            if (await _store.RemoveAsync(id, ct)) running = _engine.DeployAsync(await DeploymentAsync(), ct);

            // A flow that is gone has no draft left to test, and neither has one that was never saved: the
            // console deletes that draft here too, and its test may be all of it the engine holds. Answered
            // "no such flow" and left alone, that test would run on with no page left to stop it. Taken away,
            // and not kept stopped as a Stop keeps it, since there is no page left to read it on either.
            _engine.Post(new FlowTestStop(id, Remove: true));
        }
        finally
        {
            _deploying.Release();
        }

        if (running is null) return false;

        await running;
        return true;
    }

    /// <summary>
    /// Runs a flow's draft once, beside its active run, without keeping it — or says why it will not.
    /// Answered once the engine has been handed the test and the link has been asked for: on a host that
    /// dials at start-up, with the link down, that is after the dial — which the test itself does not wait for.
    /// </summary>
    // Not under the deploy gate: a test writes nothing and reads nothing of the file, so it has nothing
    // to interleave with. It asks for the link as a save does, and for the same reason: a test reads
    // and publishes, and somebody pressed it to see that happen.
    public async Task<FlowSaveResult> TestAsync(Flow flow, CancellationToken ct)
    {
        var compiled = FlowCompiler.Compile(flow, _options.TopicPrefix);
        if (compiled.Flow is null) return new FlowSaveResult(null, compiled.Problems);

        // One test for each flow the file can keep. Refused here, so the console can mark it as it marks a save
        // past its limit. What is counted is the tests going as the pump last left them and the starts waiting
        // for it: a pump held up leaves its last look as it was while any number of Tests are handed over, and
        // each of them parks its compiled flow in a slot. A test of a flow with one going or waiting takes its
        // place, and is not one more. The look and the hand-over are two steps, so Tests that race for the
        // last place can each be let in, and so can one that comes while the pump holds a start it has taken
        // from its slot and not yet counted; FlowRuntime.StartTest holds the line for those.
        var testing = _engine.TestsGoingOrWaiting();
        if (!testing.Contains(flow.Id) && testing.Count >= FlowLimits.Flows)
            return new FlowSaveResult(null, [new FlowProblem(null, null, $"At most {FlowLimits.Flows} tests can run at once. Stop one first.")]);

        // Handed over before the link is asked for, in the order a save hands over its deploy. A dial can
        // take as long as the connect timeout, which is longer than the console waits for an answer, and the
        // console is pressed again meanwhile: a Stop, the flow's delete, another Test of the same flow. The
        // engine takes what it is handed in the order it was handed over, so a start that waited for the dial
        // came after every one of them: after the Stop that was meant to end it, which found no test and was
        // answered that none was going; after the delete that took its flow away, which left a test of a flow
        // that is gone with nothing to end it; and in place of a newer draft of its own flow.
        //
        // What that costs is a test that runs up to its first wait before the link is up, on a host that
        // dials because of it: a Publish it reaches in that time is refused "No broker link" on its node,
        // which is true and shows there, and Test can be pressed again once the link is up. Ordering is
        // worth that. Asked with no token, as a save asks: the test runs whether or not its client stayed
        // for the answer, and a test that runs needs the link. Only a host that dials at start-up will dial
        // here — see ILinkForRules.
        _engine.Post(new FlowTestStart(compiled.Flow));
        await _link.WantedAsync(CancellationToken.None);

        return new FlowSaveResult(flow, []);
    }

    /// <summary>
    /// Stops a flow's test run where it is and keeps it to be read, or takes it away when it has ended. False
    /// when it had none going.
    /// </summary>
    // Handed over whatever the answer. A test the pump has not started yet is not going as far as anything
    // here can tell, and the stop reaches the pump after its start, or in its place; answered "none going"
    // and left there, it would start a moment later and run on. That includes a test whose Test is still
    // waiting for the link's dial, which is handed over before the dial. And a test that has ended — at an
    // End, or stopped by an earlier press of this — stays to be read until something takes it away, which
    // this is. Asked before the stop is handed over, so the answer is about the test there was and not
    // about one the pump has already stopped.
    public bool StopTest(string flowId)
    {
        var going = _engine.IsTesting(flowId);
        _engine.Post(new FlowTestStop(flowId, Remove: false));

        return going;
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
