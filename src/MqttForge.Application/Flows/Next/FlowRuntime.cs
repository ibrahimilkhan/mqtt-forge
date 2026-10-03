using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MqttForge.Application.Alerts;
using MqttForge.Domain;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Flows.Next;

/// <summary>Every run of every flow, one step at a time.</summary>
// Pure, single-threaded, no lock, no I/O and no clock of its own: the engine's pump is the only caller
// and every call carries the time, so what a flow does is tested here as a sequence of calls.
//
// Each call moves every run that can move until it waits — for a time, or for a message — reaches an
// End, or has taken its share of steps for this turn, when it stops where it is and a later turn takes
// it on. Nothing a message can contain stops a run: a step that cannot do its job counts an error and
// the run goes on its way out. A run stops only at an End, by Stop or Deactivate, by an Update, or when
// a forever loop goes round without waiting.
public sealed class FlowRuntime
{
    private readonly Random _random;
    private readonly Dictionary<FlowRunKey, FlowRun> _runs = [];
    private readonly FlowAlarmBook _alarms = new();

    private long _version;

    // What the last OnTick was told. A publish is refused while it is false: the engine would only fail
    // it a moment later, and saying so on the node here is what the reader needs to see.
    private bool _linkUp;

    public FlowRuntime() : this(Random.Shared) { }

    public FlowRuntime(Random random) => _random = random;

    /// <summary>Moves on every change the console would draw differently. The engine pushes on it.</summary>
    public long Version => _version;

    /// <summary>
    /// When the runtime next has something to do without being told: at once while a run has steps
    /// left over from its last turn, else when the earliest Wait ends, else never.
    /// </summary>
    public DateTimeOffset? NextDue
    {
        get
        {
            DateTimeOffset? due = null;

            foreach (var run in _runs.Values)
            {
                if (run.State == FlowRunState.Running) return DateTimeOffset.MinValue;
                if (run.State == FlowRunState.Waiting && run.WakeAt is { } wake && (due is null || wake < due)) due = wake;
            }

            return due;
        }
    }

    /// <summary>The filters of every run that has not ended: what the engine subscribes for the flows.</summary>
    public IReadOnlySet<string> Filters()
    {
        var filters = new HashSet<string>(StringComparer.Ordinal);

        foreach (var run in _runs.Values)
            if (run.Live)
                foreach (var input in run.Flow.Inputs)
                    filters.Add(input.Filter);

        return filters;
    }

    /// <summary>The flows whose test run has not ended: what DELETE /api/flows/{id}/test can stop.</summary>
    public IReadOnlySet<string> Testing() =>
        _runs.Values.Where(run => run.Key.Kind == FlowRunKind.Test && run.Live)
            .Select(run => run.Key.FlowId).ToHashSet(StringComparer.Ordinal);

    /// <summary>The flows with an active run, going, waiting, finished or stopped: what is switched on.</summary>
    public IReadOnlySet<string> Active() =>
        _runs.Keys.Where(key => key.Kind == FlowRunKind.Active).Select(key => key.FlowId).ToHashSet(StringComparer.Ordinal);

    /// <summary>Runs the enabled flows among <paramref name="flows"/> and ends the active runs of the rest.</summary>
    /// <param name="kept">Every flow id still in the file, so off can be told from removed.</param>
    public FlowOutcome Deploy(IReadOnlyList<CompiledFlow> flows, IReadOnlyCollection<string> kept, DateTimeOffset now)
    {
        var into = new Collector();

        // The first flow with an id is the one that counts, on or off, and any later one with the same
        // id is left out rather than thrown on: flows.json can be edited by hand, and one slip there
        // must not keep every other flow from running.
        var wanted = new Dictionary<string, CompiledFlow>(StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var flow in flows)
            if (seen.Add(flow.Id) && flow.Enabled)
                wanted.Add(flow.Id, flow);

        foreach (var key in _runs.Keys.Where(key => key.Kind == FlowRunKind.Active && !wanted.ContainsKey(key.FlowId)).ToList())
        {
            var reason = kept.Contains(key.FlowId) ? FlowAlarmBook.FlowOff : FlowAlarmBook.FlowRemoved;
            into.Resolved(_alarms.ResolveRun(key, reason, now));
            _runs.Remove(key);
        }

        foreach (var flow in wanted.Values)
        {
            var key = new FlowRunKey(flow.Id, FlowRunKind.Active);
            _runs.TryGetValue(key, out var running);

            // Unchanged: the run carries on where it is — its loops, its waits, its variables, its
            // alarms. Somebody who moved a node, or saved another flow, did not ask this one to start over.
            if (running is not null && running.Flow.Fingerprint == flow.Fingerprint) continue;

            if (running is not null) into.Resolved(_alarms.Reconcile(running.Flow, flow, now));

            var run = new FlowRun(flow, FlowRunKind.Active, now);
            _runs[key] = run;
            Drive(run, now, into);
        }

        Touch();
        return into.Outcome();
    }

    /// <summary>Runs a flow's draft once, beside its active run, in place of any test of it there was.</summary>
    public FlowOutcome StartTest(CompiledFlow flow, DateTimeOffset now)
    {
        var into = new Collector();
        var key = new FlowRunKey(flow.Id, FlowRunKind.Test);

        if (_runs.Remove(key)) into.Resolved(_alarms.ResolveRun(key, FlowAlarmBook.TestEnded, now));

        var run = new FlowRun(flow, FlowRunKind.Test, now);
        _runs[key] = run;
        Drive(run, now, into);

        Touch();
        return into.Outcome();
    }

    /// <summary>Takes a flow's test run away, going or finished. Nothing when it has none.</summary>
    public FlowOutcome StopTest(string flowId, DateTimeOffset now)
    {
        var key = new FlowRunKey(flowId, FlowRunKind.Test);
        if (!_runs.Remove(key)) return FlowOutcome.Empty;

        var into = new Collector();
        into.Resolved(_alarms.ResolveRun(key, FlowAlarmBook.TestEnded, now));

        Touch();
        return into.Outcome();
    }

    /// <summary>A message off the broker: into the queue of every MQTT in it matches, and on with the runs it wakes.</summary>
    public FlowOutcome OnMessage(MqttMessage message, DateTimeOffset now)
    {
        var heard = false;
        HashSet<FlowRun>? woken = null;

        foreach (var run in _runs.Values)
        {
            if (!run.Live) continue;

            List<MqttInNode>? matching = null;
            foreach (var input in run.Flow.Inputs)
            {
                // The alert engine's rule, and its reason: a value the broker replays on subscribe is
                // not something that just happened.
                if (message.Replay && !input.Replay) continue;
                if (!TopicFilterMatch.Matches(input.Filter, message.Topic)) continue;

                (matching ??= []).Add(input);
            }

            if (matching is null) continue;
            heard = true;

            if (run.Echo.Heard(message, now))
            {
                foreach (var input in matching) run.Counter(input.Id).Out("echo");
                continue;
            }

            foreach (var input in matching)
            {
                var queue = run.Queues[input.Id];

                // The oldest goes: a run this far behind is better off with the newest.
                if (queue.Count >= FlowLimits.QueuedMessages)
                {
                    queue.Dequeue();
                    run.Counter(input.Id).Out("dropped");
                }

                queue.Enqueue(new FlowMessage(message.Topic, message.Payload, 0));
            }

            if (run.State == FlowRunState.Waiting && run.WakeAt is null && run.At is MqttInNode waiting && matching.Contains(waiting))
            {
                run.State = FlowRunState.Running;
                (woken ??= []).Add(run);
            }
        }

        if (!heard) return FlowOutcome.Empty;

        // Only the runs this message woke. A run with steps left over from an earlier call has had its
        // share, and takes the rest at the next tick, which NextDue makes at once: moved here as well, it
        // would take another thousand steps at every arrival in a pump turn, and a run that gave up its
        // turn to a pattern that ran out of time would cost the pump another 50 ms at each.
        var into = new Collector();
        if (woken is not null)
            foreach (var run in Ordered().Where(woken.Contains))
                Drive(run, now, into);

        Touch();
        return into.Outcome();
    }

    /// <summary>The link as it is now, every Wait that has ended, and every run with steps left over.</summary>
    public FlowOutcome OnTick(DateTimeOffset now, bool connected)
    {
        var into = new Collector();
        Link(connected, now, into);

        foreach (var run in _runs.Values)
        {
            if (run.State != FlowRunState.Waiting || run.WakeAt is not { } wake) continue;

            // Over, or further off than the whole wait: the clock was set back since, and the wait is
            // over rather than as long again as the clock went back.
            if (wake <= now || wake - now > run.WaitFor) run.State = FlowRunState.Running;
        }

        DriveAll(now, into);
        return into.Outcome();
    }

    /// <summary>The link went to another broker between two looks at it: a down and an up, and nothing run between.</summary>
    public FlowOutcome OnMove(DateTimeOffset now)
    {
        var into = new Collector();
        Link(connected: false, now, into);
        Link(connected: true, now, into);

        return into.Outcome();
    }

    /// <summary>The engine could not carry out a step this runtime asked for: a publish, a webhook post.</summary>
    public FlowOutcome StepFailed(FlowRunKey key, string nodeId, string reason, DateTimeOffset now)
    {
        if (!_runs.TryGetValue(key, out var run) || !run.Flow.Nodes.ContainsKey(nodeId)) return FlowOutcome.Empty;

        var into = new Collector();
        Fail(run, nodeId, reason, now, into);

        Touch();
        return into.Outcome();
    }

    /// <summary>The broker said no to these filters; the MQTT in nodes that asked for them say so.</summary>
    public void MarkRefused(IReadOnlyCollection<string> filters)
    {
        foreach (var run in _runs.Values)
        {
            if (!run.Live) continue;

            foreach (var input in run.Flow.Inputs)
                if (filters.Contains(input.Filter))
                {
                    var counter = run.Counter(input.Id);
                    counter.Errors++;
                    counter.Note = "The broker refused this filter.";
                }
        }

        Touch();
    }

    public FlowStatus Status()
    {
        // Grouped once for the whole read, rather than walking every alarm once for every node.
        var standing = _alarms.StandingByNode(FlowLimits.StandingShown);

        return new([.. Ordered().Select(run => new FlowRunStatus(
            run.Key.FlowId,
            run.Key.Kind,
            run.State,
            run.At.Id,
            run.State != FlowRunState.Waiting ? null
                : run.WakeAt is { } until ? new FlowWaiting(until, null)
                : new FlowWaiting(null, (run.At as MqttInNode)?.Filter),
            run.Fault,
            run.Variables.ToDictionary(pair => pair.Key, pair => Excerpt(pair.Value), StringComparer.Ordinal),
            [.. run.Flow.Nodes.Keys.Select(id =>
            {
                var counter = run.Peek(id);

                return new FlowNodeStatus(id, counter.Count, new Dictionary<string, long>(counter.Outs),
                    counter.Errors, counter.Note, standing.GetValueOrDefault((run.Key, id), []));
            })]))]);
    }

    public FlowAlarms Alarms() => new(_alarms.Active(), _alarms.History());

    /// <summary>The Alerts panel's "clear history", for the flows' half of the list it shows.</summary>
    public void ClearHistory()
    {
        _alarms.ClearHistory();
        Touch();
    }

    // ---- moving runs ----

    // In one order every time, so what a call decides does not depend on how a dictionary was filled.
    private IEnumerable<FlowRun> Ordered() =>
        _runs.Values.OrderBy(run => run.Key.FlowId, StringComparer.Ordinal).ThenBy(run => run.Key.Kind);

    private void DriveAll(DateTimeOffset now, Collector into)
    {
        foreach (var run in Ordered().Where(run => run.State == FlowRunState.Running).ToList())
            Drive(run, now, into);
    }

    /// <summary>Moves one run until it waits, ends, or has taken its share of this turn.</summary>
    private void Drive(FlowRun run, DateTimeOffset now, Collector into)
    {
        run.YieldNow = false;

        for (var steps = 0; steps < FlowLimits.StepsPerTurn && run.State == FlowRunState.Running && !run.YieldNow; steps++)
        {
            var at = run.At;

            try
            {
                Step(run, now, into);
            }
            catch (Exception ex)
            {
                // AlertEngineCore.EvaluateGuarded's rule, for a run: deliberately every exception. A step
                // that throws leaves the run where it was, so every call after this one would take the
                // same step and throw again, NextDue would say "at once", and the pump would do nothing
                // else for any flow. No step is known to throw; this is for the one nobody has thought of.
                Stop(run, at.Id, $"This step failed, so the run was stopped: {ex.Message}", now, into);
            }
        }

        Touch();
    }

    private void Step(FlowRun run, DateTimeOffset now, Collector into)
    {
        var node = run.At;
        var port = run.AtPort;
        var resuming = run.Resuming;
        run.Resuming = false;

        // A node a run waited at is entered once, however long it waited there.
        if (!resuming) run.Counter(node.Id).Count++;

        switch (node)
        {
            case StartNode:
                Go(run, node, "out");
                break;
            case EndNode:
                End(run, now, into);
                break;
            case MqttInNode input:
                Read(run, input);
                break;
            case IfNode decision:
                Decide(run, decision, now, into);
                break;
            case ForNode loop:
                For(run, loop, port, now, into);
                break;
            case ForEachNode loop:
                ForEach(run, loop, port, now, into);
                break;
            case WaitNode wait:
                Wait(run, wait, resuming, now, into);
                break;
            case SetNode set:
                Set(run, set, now, into);
                break;
            case PublishNode publish:
                Publish(run, publish, now, into);
                Go(run, publish, "out");
                break;
            case DebugNode debug:
                into.Debug.Add(DebugLine(run, debug.Id, now, FlowDebugEntry.Message, run.Message.Topic, run.Message.Payload));
                run.Counter(debug.Id).Note = Excerpt(run.Message.Payload);
                Go(run, debug, "out");
                break;
            case AlarmRaiseNode raise:
                Raise(run, raise, now, into);
                break;
            case AlarmClearNode clear:
                var cleared = _alarms.Clear(run.Key, clear.Alarm, run.Message.Topic, now);
                if (cleared is not null) into.Resolved([cleared]);
                Go(run, clear, cleared is not null ? "cleared" : "none");
                break;
            case SoundNode sound:
                Sound(run, sound, now, into);
                Go(run, sound, "out");
                break;
            case NotifyNode notify:
                Notify(run, notify, now, into);
                Go(run, notify, "out");
                break;
            case WebhookNode webhook:
                Webhook(run, webhook, now, into);
                Go(run, webhook, "out");
                break;
        }
    }

    private static void Go(FlowRun run, CompiledNode from, string port)
    {
        run.Counter(from.Id).Out(port);

        var target = from.To(port);
        run.At = target.Node;
        run.AtPort = target.Port;
    }

    private void End(FlowRun run, DateTimeOffset now, Collector into)
    {
        run.State = FlowRunState.Finished;
        run.ForgetQueued();

        // A test is over when it reaches an End, and so are its alarms: a test leaves nothing standing.
        // An active run's alarms stay up — they are real, and nothing pretends the plant got better.
        if (run.Key.Kind == FlowRunKind.Test) into.Resolved(_alarms.ResolveRun(run.Key, FlowAlarmBook.TestEnded, now));
    }

    /// <summary>Ends a run where it is, with its fault said on the flow and on the node.</summary>
    private void Stop(FlowRun run, string nodeId, string fault, DateTimeOffset now, Collector into)
    {
        run.State = FlowRunState.Stopped;

        // Cut as a note is, since it stands in the flow's pane the way a note stands under a node: a
        // fault that quotes an exception is as long as the exception made it. The debug line keeps more.
        run.Fault = Excerpt(fault);
        run.ForgetQueued();
        Fail(run, nodeId, fault, now, into, run.Message.Topic);

        if (run.Key.Kind == FlowRunKind.Test) into.Resolved(_alarms.ResolveRun(run.Key, FlowAlarmBook.TestEnded, now));
    }

    private static void Read(FlowRun run, MqttInNode input)
    {
        if (!run.Queues[input.Id].TryDequeue(out var message))
        {
            run.State = FlowRunState.Waiting;
            run.Resuming = true;
            return;
        }

        run.Pauses++;
        run.Message = message with { Index = run.Message.Index };
        run.Counter(input.Id).Note = Excerpt(message.Payload);
        Go(run, input, "out");
    }

    private void Decide(FlowRun run, IfNode decision, DateTimeOffset now, Collector into)
    {
        var text = decision.Field.Read(run.Message, run.Variables);
        var value = decision.Value.Render(run.Message, run.Variables, now, _random, FlowLimits.TextTemplateLength, out _);
        var value2 = decision.Value2.Render(run.Message, run.Variables, now, _random, FlowLimits.TextTemplateLength, out _);

        run.Counter(decision.Id).Note = text is null ? "no such field" : Excerpt(text);

        bool yes;
        try
        {
            yes = decision.Test.Judge(text, value, value2);
        }
        catch (FlowStepException ex)
        {
            Fail(run, decision.Id, ex.Message, now, into, run.Message.Topic);
            yes = false;
        }
        catch (RegexMatchTimeoutException)
        {
            // The run's share of this turn ends here as well: the next text like this one would cost the
            // pump another 50 ms, and every run shares the pump.
            Fail(run, decision.Id, "The pattern took longer than 50 ms, so this message went no.", now, into, run.Message.Topic);
            run.YieldNow = true;
            yes = false;
        }

        Go(run, decision, yes ? "yes" : "no");
    }

    private void For(FlowRun run, ForNode loop, string port, DateTimeOffset now, Collector into)
    {
        if (port == FlowPorts.Next)
        {
            Turn(run, loop, now, into);
            return;
        }

        long? total = null;
        if (!loop.Forever)
        {
            var text = loop.Times.Render(run.Message, run.Variables, now, _random, 64, out _);
            if (FlowNumbers.Times(text) is not { } times)
            {
                Fail(run, loop.Id, $"Times has to be a whole number from 0 to 1,000,000; it came out as '{Excerpt(text)}'.",
                    now, into, run.Message.Topic);
                Go(run, loop, "done");
                return;
            }

            total = times;
        }

        Enter(run, loop, new LoopState(run.Message, total, null));
    }

    private void ForEach(FlowRun run, ForEachNode loop, string port, DateTimeOffset now, Collector into)
    {
        if (port == FlowPorts.Next)
        {
            Turn(run, loop, now, into);
            return;
        }

        var text = loop.Array.Read(run.Message, run.Variables);
        var items = Items(text, out var more, out var unread);

        if (items is null)
        {
            Fail(run, loop.Id, text is null
                    ? "There is no array here: the message does not carry the field."
                    : $"This is not an array: '{Excerpt(text)}'.",
                now, into, run.Message.Topic);
            Go(run, loop, "done");
            return;
        }

        if (more)
            Fail(run, loop.Id, $"Only the first {FlowLimits.ForEachElements:N0} elements are walked.", now, into, run.Message.Topic);

        if (unread > 0)
            Fail(run, loop.Id, unread == 1
                    ? "An element could not be read as text, so it was left out."
                    : $"{unread} elements could not be read as text, so they were left out.",
                now, into, run.Message.Topic);

        Enter(run, loop, new LoopState(run.Message, items.Count, items));
    }

    /// <summary>A loop entered by its way in: its first turn, or straight out by done when it has none.</summary>
    private static void Enter(FlowRun run, CompiledNode loop, LoopState state)
    {
        if (state.Total == 0)
        {
            run.Loops.Remove(loop.Id);
            Go(run, loop, "done");
            return;
        }

        run.Loops[loop.Id] = state;
        state.PausesAtTurn = run.Pauses;
        Body(run, loop, state);
    }

    /// <summary>The body's last step came back: the next turn, or done after the last.</summary>
    private void Turn(FlowRun run, CompiledNode loop, DateTimeOffset now, Collector into)
    {
        if (!run.Loops.TryGetValue(loop.Id, out var state))
        {
            // The compiler lets only a loop's own body come back to it, so this is a fault in this
            // class and not in a drawing; the run ends rather than guess which turn this was.
            Stop(run, loop.Id, "The loop's next was reached outside a turn of it.", now, into);
            return;
        }

        // A forever loop that came round without waiting would go round as fast as the server can.
        if (state.Total is null && run.Pauses == state.PausesAtTurn)
        {
            Stop(run, loop.Id, "This loop ran a turn without waiting, so the run was stopped. Put a Wait in it.", now, into);
            return;
        }

        state.Turn++;

        if (state.Total is { } total && state.Turn > total)
        {
            run.Loops.Remove(loop.Id);
            run.Message = state.Entry;
            Go(run, loop, "done");
            return;
        }

        state.PausesAtTurn = run.Pauses;
        Body(run, loop, state);
    }

    private static void Body(FlowRun run, CompiledNode loop, LoopState state)
    {
        var index = (int)Math.Min(state.Turn, int.MaxValue);

        run.Message = state.Items is { } items
            ? state.Entry with { Payload = items[(int)state.Turn - 1], Index = index }
            : state.Entry with { Index = index };

        run.Counter(loop.Id).Note = state.Total is { } total ? $"turn {state.Turn} of {total}" : $"turn {state.Turn}";
        Go(run, loop, "body");
    }

    private void Wait(FlowRun run, WaitNode wait, bool resuming, DateTimeOffset now, Collector into)
    {
        if (resuming)
        {
            run.WakeAt = null;
            run.Pauses++;
            Go(run, wait, "out");
            return;
        }

        var text = wait.Seconds.Render(run.Message, run.Variables, now, _random, 64, out _);
        if (FlowNumbers.Seconds(text) is not { } span)
        {
            Fail(run, wait.Id, $"Wait needs a number of seconds from 0.1 to 86,400; it came out as '{Excerpt(text)}'.",
                now, into, run.Message.Topic);
            Go(run, wait, "out");
            return;
        }

        run.WakeAt = now + span;
        run.WaitFor = span;
        run.State = FlowRunState.Waiting;
        run.Resuming = true;
        run.Counter(wait.Id).Note = $"{text.Trim()} s";
    }

    private void Set(FlowRun run, SetNode set, DateTimeOffset now, Collector into)
    {
        var value = set.Value.Render(run.Message, run.Variables, now, _random, FlowLimits.VariableBytes, out var cut);

        if (cut || Encoding.UTF8.GetByteCount(value) > FlowLimits.VariableBytes)
            Fail(run, set.Id, $"{set.Variable} would be over 64 KB, so it keeps what it had.", now, into, run.Message.Topic);
        else
        {
            run.Variables[set.Variable] = value;

            // The value is cut before the sentence is made of it, so the note costs what it shows and not
            // a copy of a value that may be 64 KB. The note is the same either way: the sentence starts
            // with at least four characters, and Excerpt keeps no more than the first seventy-nine.
            run.Counter(set.Id).Note = Excerpt($"{set.Variable} = {FlowTemplate.Clip(value, FlowLimits.NoteLength)}");
        }

        Go(run, set, "out");
    }

    private void Publish(FlowRun run, PublishNode node, DateTimeOffset now, Collector into)
    {
        var arrived = run.Message.Topic;

        // The link and the rate before anything is rendered: a publish either of them drops would
        // otherwise pay for its render first.
        if (!_linkUp)
        {
            Fail(run, node.Id, "No broker link, so nothing was published.", now, into, arrived);
            return;
        }

        if (!run.Bucket.TryTake(now))
        {
            Fail(run, node.Id, $"More than {FlowLimits.PublishesPerSecond} publishes a second; this one was dropped.", now, into, arrived);
            return;
        }

        var topic = node.Topic.Render(run.Message, run.Variables, now, _random, FlowLimits.TopicBytes, out var topicCut);

        if (topicCut || Encoding.UTF8.GetByteCount(topic) > FlowLimits.TopicBytes)
        {
            Fail(run, node.Id, "The topic came out longer than the 65,535 bytes MQTT allows, so nothing was published.", now, into, arrived);
            return;
        }

        if (topic.Length == 0 || topic.AsSpan().IndexOfAny('+', '#') >= 0 || topic.Contains('\0'))
        {
            Fail(run, node.Id, $"The topic came out as '{topic}', which cannot be published to.", now, into, arrived);
            return;
        }

        // Rendered to the limit in characters at most. A character is at least a byte, so a payload that
        // was cut there is over 64 KB whatever it held, and one that was not is measured.
        var payload = node.Payload.Render(run.Message, run.Variables, now, _random, FlowLimits.PayloadBytes, out var payloadCut);
        var bytes = payloadCut ? null : Encoding.UTF8.GetBytes(payload);

        if (bytes is null || bytes.Length > FlowLimits.PayloadBytes)
        {
            Fail(run, node.Id, "The payload came out larger than 64 KB and was not published.", now, into, topic);
            return;
        }

        run.Echo.Remember(topic, bytes, now);
        into.Publishes.Add(new FlowPublish(run.Key, node.Id, new PublishRequest(topic, bytes, node.Qos, node.Retain)));

        var counter = run.Counter(node.Id);
        counter.Out("sent");
        counter.Note = Excerpt(topic);
    }

    private void Raise(FlowRun run, AlarmRaiseNode raise, DateTimeOffset now, Collector into)
    {
        var (alert, isNew) = _alarms.Raise(run.Flow, run.Key.Kind, raise, run.Message, run.Variables, now, _random);

        if (alert is null)
        {
            Fail(run, raise.Id, "Too many alarms are up; this one was not raised.", now, into, run.Message.Topic);
            Go(run, raise, "up");
            return;
        }

        run.Counter(raise.Id).Note = Excerpt(alert.Reason);
        if (isNew) into.Raised(alert);

        Go(run, raise, isNew ? "raised" : "up");
    }

    private static void Sound(FlowRun run, SoundNode sound, DateTimeOffset now, Collector into)
    {
        if (!Allowed(run, sound.Id, now)) return;

        into.Sounds.Add(new FlowSound(run.Key.FlowId, sound.Id, sound.Level, run.Key.Kind == FlowRunKind.Test));
        run.Counter(sound.Id).Out("played");
    }

    private void Notify(FlowRun run, NotifyNode notify, DateTimeOffset now, Collector into)
    {
        if (!Allowed(run, notify.Id, now)) return;

        var text = notify.Text.Render(run.Message, run.Variables, now, _random, FlowLimits.NoticeLength, out _);
        into.Notices.Add(new FlowNotice(run.Key.FlowId, run.Flow.Name, notify.Id, text, notify.Level, now, run.Key.Kind == FlowRunKind.Test));

        var counter = run.Counter(notify.Id);
        counter.Out("shown");
        counter.Note = Excerpt(text);
    }

    private void Webhook(FlowRun run, WebhookNode webhook, DateTimeOffset now, Collector into)
    {
        if (!Allowed(run, webhook.Id, now)) return;

        var body = webhook.Body.Render(run.Message, run.Variables, now, _random, FlowLimits.PayloadBytes, out var cut);
        if (cut || Encoding.UTF8.GetByteCount(body) > FlowLimits.PayloadBytes)
        {
            Fail(run, webhook.Id, "The body came out larger than 64 KB and was not sent.", now, into, run.Message.Topic);
            return;
        }

        into.Webhooks.Add(new FlowWebhookPost(run.Key, webhook.Id, webhook.Url, body, IsJson(body) ? "application/json" : "text/plain"));
        run.Counter(webhook.Id).Out("posted");
    }

    /// <summary>One job a second for each Sound, Notify and Webhook node: the rest are counted and let go.</summary>
    private static bool Allowed(FlowRun run, string nodeId, DateTimeOffset now)
    {
        // A clock set back counts as a second gone by, or the node would stay quiet until the clock had
        // caught up with where it was.
        if (run.ChannelAt.TryGetValue(nodeId, out var last) && now >= last && now - last < FlowLimits.ChannelEvery)
        {
            run.Counter(nodeId).Out("dropped");
            return false;
        }

        run.ChannelAt[nodeId] = now;
        return true;
    }

    private static bool IsJson(string text)
    {
        try
        {
            using var _ = JsonDocument.Parse(text);
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    /// <summary>
    /// A JSON array's elements as text — a string as itself, anything else as its JSON — whether there
    /// were more than the limit, and how many could not be read as text.
    /// </summary>
    private static List<string>? Items(string? text, out bool more, out int unread)
    {
        more = false;
        unread = 0;
        if (text is null) return null;

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(text);
        }
        catch (JsonException)
        {
            return null;
        }

        using (document)
        {
            if (document.RootElement.ValueKind != JsonValueKind.Array) return null;

            var items = new List<string>();
            foreach (var element in document.RootElement.EnumerateArray())
            {
                if (items.Count == FlowLimits.ForEachElements)
                {
                    more = true;
                    break;
                }

                // A string element is its text, not its JSON: ["k1","k2"] gives k1 and k2, which is what
                // a topic template wants to put between two slashes. Read the way every field is read,
                // so an element that is no text at all, an escaped half of a surrogate pair, is not
                // there, and the walk goes on without it.
                if (PayloadValue.TryText(element, out var item)) items.Add(item);
                else unread++;
            }

            return items;
        }
    }

    private void Link(bool connected, DateTimeOffset now, Collector into)
    {
        if (_linkUp && !connected)
        {
            // The alert engine's "connection ended": with no link nothing is being watched, and an alarm
            // left standing would be a claim about a plant nobody can see.
            into.Resolved(_alarms.ResolveAll(FlowAlarmBook.ConnectionEnded, now));
            Touch();
        }

        _linkUp = connected;
    }

    private static void Fail(FlowRun run, string nodeId, string reason, DateTimeOffset now, Collector into, string topic = "")
    {
        var counter = run.Counter(nodeId);
        counter.Errors++;
        counter.Note = Excerpt(reason);
        into.Debug.Add(DebugLine(run, nodeId, now, FlowDebugEntry.Error, topic, reason));
    }

    /// <summary>A line for the debug strip, with neither its topic nor its text longer than an excerpt.</summary>
    private static FlowDebugEntry DebugLine(FlowRun run, string nodeId, DateTimeOffset at, string kind, string topic, string text) =>
        new(run.Key.FlowId, nodeId, at, kind,
            FlowTemplate.Clip(topic, FlowLimits.DebugExcerpt), FlowTemplate.Clip(text, FlowLimits.DebugExcerpt),
            run.Key.Kind == FlowRunKind.Test);

    /// <summary>One line, short enough to stand under a node.</summary>
    // Cut before the line endings are replaced, so a note costs the eighty characters it keeps and not a
    // copy of a 64 KB payload made first. Never between the halves of a surrogate pair.
    private static string Excerpt(string text)
    {
        if (text.Length <= FlowLimits.NoteLength) return text.ReplaceLineEndings(" ");

        return FlowTemplate.Clip(text, FlowLimits.NoteLength - 1).ReplaceLineEndings(" ") + "…";
    }

    private void Touch() => _version++;

    private sealed class Collector
    {
        public List<FlowPublish> Publishes { get; } = [];
        public List<AlertEvent> Alarms { get; } = [];
        public List<FlowDebugEntry> Debug { get; } = [];
        public List<FlowSound> Sounds { get; } = [];
        public List<FlowNotice> Notices { get; } = [];
        public List<FlowWebhookPost> Webhooks { get; } = [];

        public void Raised(Alert alert) => Alarms.Add(new AlertEvent(alert, Raised: true));

        public void Resolved(IEnumerable<Alert> alerts)
        {
            foreach (var alert in alerts) Alarms.Add(new AlertEvent(alert, Raised: false));
        }

        public FlowOutcome Outcome() =>
            Publishes.Count == 0 && Alarms.Count == 0 && Debug.Count == 0 &&
            Sounds.Count == 0 && Notices.Count == 0 && Webhooks.Count == 0
                ? FlowOutcome.Empty
                : new FlowOutcome(Publishes, Alarms, Debug, Sounds, Notices, Webhooks);
    }
}
