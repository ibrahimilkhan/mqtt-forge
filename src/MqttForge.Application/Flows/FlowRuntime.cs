using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MqttForge.Application.Alerts;
using MqttForge.Domain;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Flows;

/// <summary>Every running flow, and everything that happens to one.</summary>
// Pure, single-threaded, no lock, no I/O and no clock of its own: FlowEngine's pump is the only
// caller and every call carries the time. The same division as AlertEngineCore and AlertEngine —
// what a flow does is tested here as a sequence of calls, and the thread is tested there.
//
// A message runs depth first, one wire at a time in the order the wires were drawn. The graph is
// acyclic (the compiler refused anything else), so the recursion is as deep as the longest path
// through one flow and no deeper; the step budget bounds how wide it can spread.
public sealed class FlowRuntime
{
    private readonly Random _random;
    private readonly Dictionary<string, FlowState> _flows = new(StringComparer.Ordinal);
    private readonly PriorityQueue<Scheduled, DateTimeOffset> _schedule = new();
    private readonly FlowAlarmBook _alarms = new();

    private long _generation;
    private long _version;

    // What the last OnTick was told. A publish is refused while it is false: the engine would only
    // fail it a moment later, and saying so on the node here is what the reader needs to see.
    private bool _linkUp;

    public FlowRuntime() : this(Random.Shared) { }

    public FlowRuntime(Random random) => _random = random;

    /// <summary>Moves on every change the console would draw differently. The engine pushes on it.</summary>
    public long Version => _version;

    /// <summary>When the next Every tick or Repeat copy is due, if any is.</summary>
    public DateTimeOffset? NextDue => _schedule.TryPeek(out _, out var due) ? due : null;

    public IReadOnlyCollection<string> Filters()
    {
        var filters = new HashSet<string>(StringComparer.Ordinal);
        foreach (var state in _flows.Values)
            foreach (var input in state.Flow.Inputs)
                filters.Add(input.Filter);

        return filters;
    }

    public IReadOnlySet<(string FlowId, string NodeId)> Injectable()
    {
        var injectable = new HashSet<(string, string)>();
        foreach (var state in _flows.Values)
            foreach (var node in state.Flow.Nodes.Values)
                if (node is InjectNode)
                    injectable.Add((state.Flow.Id, node.Id));

        return injectable;
    }

    /// <summary>Runs the enabled flows among <paramref name="flows"/>, and stops the rest.</summary>
    /// <param name="kept">Every flow id still in the file, so off can be told from removed.</param>
    public FlowOutcome Deploy(IReadOnlyList<CompiledFlow> flows, IReadOnlyCollection<string> kept, DateTimeOffset now)
    {
        var into = new Collector();

        // The first flow with an id is the one that counts, on or off, and any later one with the
        // same id is left out rather than thrown on. The console never writes two, but flows.json
        // can be edited by hand, and one slip there must not keep every other flow from running.
        var wanted = new Dictionary<string, CompiledFlow>(StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var flow in flows)
            if (seen.Add(flow.Id) && flow.Enabled)
                wanted.Add(flow.Id, flow);

        foreach (var id in _flows.Keys.Where(id => !wanted.ContainsKey(id)).ToList())
        {
            var reason = kept.Contains(id) ? FlowAlarmBook.FlowOff : FlowAlarmBook.FlowRemoved;
            into.Resolved.AddRange(_alarms.ResolveFlow(id, reason, now));
            _flows.Remove(id);
        }

        foreach (var flow in wanted.Values)
        {
            _flows.TryGetValue(flow.Id, out var running);

            // Untouched: its counters, its timers and its alarms carry on as they were. Somebody who
            // moved a node, or deployed a different flow, did not ask for this one to start over.
            if (running is not null && running.Flow.Fingerprint == flow.Fingerprint) continue;

            if (running is not null) into.Resolved.AddRange(_alarms.Reconcile(running.Flow, flow, now));

            // A new generation strands whatever the old one had scheduled: those entries are skipped
            // when they come due rather than hunted down in the queue now.
            var state = new FlowState(flow, ++_generation, now);
            _flows[flow.Id] = state;

            foreach (var every in flow.Timers)
                _schedule.Enqueue(Scheduled.Tick(state, every), now + every.Interval);
        }

        Touch();
        return into.Outcome();
    }

    public FlowOutcome OnMessage(MqttMessage message, DateTimeOffset now)
    {
        Collector? into = null;

        foreach (var state in _flows.Values)
        {
            List<MqttInNode>? matching = null;

            foreach (var input in state.Flow.Inputs)
            {
                // The alert engine's rule, and the same reason: a value the broker replays on
                // subscribe is not something that just happened.
                if (message.Replay && !input.Replay) continue;
                if (!TopicFilterMatch.Matches(input.Filter, message.Topic)) continue;

                (matching ??= []).Add(input);
            }

            if (matching is null) continue;

            if (state.Echo.Heard(message, now))
            {
                foreach (var input in matching) state.Counter(input.Id).Out("echo");
                Touch();
                continue;
            }

            into ??= new Collector();
            foreach (var input in matching)
            {
                var counter = state.Counter(input.Id);
                counter.Count++;
                counter.Note = Excerpt(message.Payload);

                var run = new Run(state, now, into);
                Emit(run, input, "out", new FlowMessage(message.Topic, message.Payload));
                Finish(run, input);
            }

            Touch();
        }

        return into?.Outcome() ?? FlowOutcome.Empty;
    }

    /// <summary>The link as it is now, and every Every tick and Repeat copy that has come due.</summary>
    public FlowOutcome OnTick(DateTimeOffset now, bool connected)
    {
        var into = new Collector();
        Link(connected, now, into);

        while (_schedule.TryPeek(out var item, out var due) && due <= now)
        {
            _schedule.Dequeue();

            if (!_flows.TryGetValue(item.FlowId, out var state) || state.Generation != item.Generation) continue;
            if (!state.Flow.Nodes.TryGetValue(item.NodeId, out var node)) continue;

            var run = new Run(state, now, into);

            if (node is EveryNode every)
            {
                var counter = state.Counter(every.Id);
                counter.Count++;

                Emit(run, every, "out", item.Message with { Index = (int)Math.Min(counter.Count, int.MaxValue) });
                _schedule.Enqueue(item, NextAfter(due, every.Interval, now));
            }
            else if (node is RepeatNode repeat)
            {
                Emit(run, repeat, "out", item.Message);

                if (item.Remaining > 1)
                    _schedule.Enqueue(
                        item with { Message = item.Message with { Index = item.Message.Index + 1 }, Remaining = item.Remaining - 1 },
                        NextAfter(due, repeat.Interval, now));
                else
                    state.Sequences[repeat.Id] = Math.Max(0, state.Sequences.GetValueOrDefault(repeat.Id) - 1);
            }

            Finish(run, node);
            Touch();
        }

        return into.Outcome();
    }

    /// <summary>The link went to another broker between two looks at it: a down and an up, and nothing run between.</summary>
    // Not OnTick down and up. The down would run whatever has come due against a link that was never
    // gone and refuse every publish in it; the next tick runs it, on the link that is up.
    public FlowOutcome OnMove(DateTimeOffset now)
    {
        var into = new Collector();
        Link(connected: false, now, into);
        Link(connected: true, now, into);

        return into.Outcome();
    }

    public FlowOutcome Inject(string flowId, string nodeId, DateTimeOffset now)
    {
        if (!_flows.TryGetValue(flowId, out var state) ||
            !state.Flow.Nodes.TryGetValue(nodeId, out var node) ||
            node is not InjectNode inject)
            return FlowOutcome.Empty;

        var into = new Collector();
        var run = new Run(state, now, into);

        state.Counter(inject.Id).Count++;
        Emit(run, inject, "out", new FlowMessage(inject.Topic, inject.Payload));
        Finish(run, inject);
        Touch();

        return into.Outcome();
    }

    /// <summary>The engine could not send a publish this runtime asked for.</summary>
    public FlowOutcome PublishFailed(string flowId, string nodeId, string reason, DateTimeOffset now)
    {
        if (!_flows.TryGetValue(flowId, out var state) || !state.Flow.Nodes.ContainsKey(nodeId))
            return FlowOutcome.Empty;

        var into = new Collector();
        Fail(state, nodeId, reason, "", now, into);
        Touch();

        return into.Outcome();
    }

    /// <summary>The broker said no to these filters; the inputs that asked for them say so.</summary>
    public void MarkRefused(IReadOnlyCollection<string> filters)
    {
        foreach (var state in _flows.Values)
            foreach (var input in state.Flow.Inputs)
                if (filters.Contains(input.Filter))
                {
                    var counter = state.Counter(input.Id);
                    counter.Errors++;
                    counter.Note = "The broker refused this filter.";
                }

        Touch();
    }

    public FlowStatus Status() => new([.. _flows.Values.Select(state => new FlowRunStatus(
        state.Flow.Id,
        state.Faults,
        state.Fault,
        [.. state.Flow.Nodes.Keys.Select(id =>
        {
            var counter = state.Peek(id);
            var standing = state.Flow.Nodes[id] is AlarmNode
                ? _alarms.StandingFor(state.Flow.Id, id, FlowLimits.StandingShown)
                : [];

            return new FlowNodeStatus(id, counter.Count, new Dictionary<string, long>(counter.Outs),
                counter.Errors, counter.Note, standing);
        })]))]);

    public FlowAlarms Alarms() => new(_alarms.Active(), _alarms.History());

    // ---- one event ----

    private void Link(bool connected, DateTimeOffset now, Collector into)
    {
        if (_linkUp && !connected)
        {
            // The alert engine's "connection ended": with no link nothing is being watched, and an
            // alarm left standing would be a claim about a plant nobody can see.
            into.Resolved.AddRange(_alarms.ResolveAll(FlowAlarmBook.ConnectionEnded, now));
            Touch();
        }

        _linkUp = connected;
    }

    private void Emit(Run run, CompiledNode from, string port, FlowMessage message)
    {
        run.State.Counter(from.Id).Out(port);

        foreach (var target in from.To(port))
        {
            if (run.Exhausted) return;
            Enter(run, target.Node, target.Port, message);
        }
    }

    private void Enter(Run run, CompiledNode node, string port, FlowMessage message)
    {
        if (++run.Steps > FlowLimits.StepsPerEvent)
        {
            run.Exhausted = true;
            return;
        }

        run.State.Counter(node.Id).Count++;

        switch (node)
        {
            case IfNode test:
                If(run, test, message);
                break;
            case ForEachNode each:
                ForEach(run, each, message);
                break;
            case RepeatNode repeat:
                Repeat(run, repeat, message);
                break;
            case AlarmNode alarm:
                Alarm(run, alarm, port, message);
                break;
            case PublishNode publish:
                Publish(run, publish, message);
                break;
            case DebugNode debug:
                run.Into.Debug.Add(DebugLine(run.State, debug.Id, run.Now, FlowDebugEntry.Message, message.Topic, message.Payload));
                run.State.Counter(debug.Id).Note = Excerpt(message.Payload);
                break;
        }
    }

    private void If(Run run, IfNode node, FlowMessage message)
    {
        var text = PayloadValue.TryExtract(message.Payload, node.Field, out var found) ? found : null;
        var counter = run.State.Counter(node.Id);

        FlowVerdict verdict;
        try
        {
            verdict = node.Test.Judge(text);
        }
        catch (RegexMatchTimeoutException)
        {
            Fail(run.State, node.Id, "The pattern took longer than 50 ms and was stopped.", message.Topic, run.Now, run.Into);
            return;
        }

        counter.Note = text is null ? "no such field" : Excerpt(text);

        switch (verdict)
        {
            case FlowVerdict.Yes:
                Emit(run, node, "yes", message);
                break;
            case FlowVerdict.No:
                Emit(run, node, "no", message);
                break;
            default:
                counter.Out("skipped");
                break;
        }
    }

    private void ForEach(Run run, ForEachNode node, FlowMessage message)
    {
        var counter = run.State.Counter(node.Id);

        if (!PayloadValue.TryExtract(message.Payload, node.Field, out var text) || text is null)
        {
            counter.Out("skipped");
            counter.Note = "no such field";
            return;
        }

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(text);
        }
        catch (JsonException)
        {
            counter.Out("skipped");
            counter.Note = "not an array";
            return;
        }

        using (document)
        {
            if (document.RootElement.ValueKind != JsonValueKind.Array)
            {
                counter.Out("skipped");
                counter.Note = "not an array";
                return;
            }

            // The array it read, as an If shows the value it read. Without this a "not an array"
            // left by one odd message would stand under a node that has walked arrays ever since.
            counter.Note = Excerpt(text);

            var index = 0;
            foreach (var element in document.RootElement.EnumerateArray())
            {
                if (index == FlowLimits.ForEachElements)
                {
                    Fail(run.State, node.Id, $"Only the first {FlowLimits.ForEachElements} elements were sent on.",
                        message.Topic, run.Now, run.Into);
                    return;
                }

                index++;

                // A string element is its text, not its JSON: ["k1","k2"] gives k1 and k2, which is
                // what a topic template wants to put between two slashes.
                var payload = element.ValueKind == JsonValueKind.String ? element.GetString()! : element.GetRawText();
                Emit(run, node, "out", message with { Payload = payload, Index = index });

                if (run.Exhausted) return;
            }
        }
    }

    private void Repeat(Run run, RepeatNode node, FlowMessage message)
    {
        var state = run.State;
        var scheduled = node.Count > 1 && node.Interval > TimeSpan.Zero;

        if (scheduled && state.Sequences.GetValueOrDefault(node.Id) >= FlowLimits.RepeatSequences)
        {
            Fail(state, node.Id, $"{FlowLimits.RepeatSequences} sequences were already running; this one was dropped.",
                message.Topic, run.Now, run.Into);
            return;
        }

        Emit(run, node, "out", message with { Index = 1 });

        if (node.Count == 1) return;

        if (!scheduled)
        {
            for (var copy = 2; copy <= node.Count && !run.Exhausted; copy++)
                Emit(run, node, "out", message with { Index = copy });
            return;
        }

        state.Sequences[node.Id] = state.Sequences.GetValueOrDefault(node.Id) + 1;
        _schedule.Enqueue(
            new Scheduled(state.Flow.Id, state.Generation, node.Id, message with { Index = 2 }, node.Count - 1),
            run.Now + node.Interval);
    }

    private void Alarm(Run run, AlarmNode node, string port, FlowMessage message)
    {
        var counter = run.State.Counter(node.Id);

        if (port == "clear")
        {
            if (_alarms.Clear(run.State.Flow.Id, node.Id, message.Topic, run.Now) is { } cleared)
            {
                run.Into.Resolved.Add(cleared);
                counter.Out("cleared");
            }

            return;
        }

        var (alert, isNew) = _alarms.Raise(run.State.Flow, node, message, run.Now, _random);
        if (alert is null)
        {
            Fail(run.State, node.Id, "Too many alarms are up; this one was not raised.", message.Topic, run.Now, run.Into);
            return;
        }

        counter.Note = Excerpt(alert.Reason);

        if (!isNew) return;

        run.Into.Raised.Add(alert);
        counter.Out("raised");
    }

    private void Publish(Run run, PublishNode node, FlowMessage message)
    {
        var state = run.State;
        var topic = node.Topic.Render(message, run.Now, _random);

        if (topic.Length == 0 || topic.AsSpan().IndexOfAny('+', '#') >= 0 || topic.Contains('\0'))
        {
            Fail(state, node.Id, $"The topic came out as '{topic}', which cannot be published to.", message.Topic, run.Now, run.Into);
            return;
        }

        var payload = node.Payload.Render(message, run.Now, _random);
        var bytes = Encoding.UTF8.GetBytes(payload);

        if (bytes.Length > FlowLimits.PayloadBytes)
        {
            Fail(state, node.Id, "The payload came out larger than 64 KB and was not published.", topic, run.Now, run.Into);
            return;
        }

        if (!_linkUp)
        {
            Fail(state, node.Id, "No broker link, so nothing was published.", topic, run.Now, run.Into);
            return;
        }

        if (!state.Bucket.TryTake(run.Now))
        {
            Fail(state, node.Id, $"More than {FlowLimits.PublishesPerSecond} publishes a second; this one was dropped.",
                topic, run.Now, run.Into);
            return;
        }

        state.Echo.Remember(topic, bytes, run.Now);
        run.Into.Publishes.Add(new FlowPublish(state.Flow.Id, node.Id, new PublishRequest(topic, bytes, node.Qos, node.Retain)));

        var counter = state.Counter(node.Id);
        counter.Out("sent");
        counter.Note = Excerpt(topic);
    }

    private void Finish(Run run, CompiledNode start)
    {
        if (!run.Exhausted) return;

        var state = run.State;
        state.Faults++;
        state.Fault = $"An event ran more than {FlowLimits.StepsPerEvent} nodes and was stopped.";
        run.Into.Debug.Add(DebugLine(state, start.Id, run.Now, FlowDebugEntry.Error, "", state.Fault));
    }

    private static void Fail(FlowState state, string nodeId, string reason, string topic, DateTimeOffset now, Collector into)
    {
        var counter = state.Counter(nodeId);
        counter.Errors++;
        counter.Note = Excerpt(reason);
        into.Debug.Add(DebugLine(state, nodeId, now, FlowDebugEntry.Error, topic, reason));
    }

    /// <summary>A line for the debug strip, with neither its topic nor its text longer than an excerpt.</summary>
    // Every line is made here, so none can miss the cut, and both halves need it. A Debug node prints
    // whatever arrived, topic and all; a Publish that failed carries the topic it rendered, which
    // with {{payload}} in its template is as long as the payload, and its reason may quote it again.
    private static FlowDebugEntry DebugLine(
        FlowState state, string nodeId, DateTimeOffset at, string kind, string topic, string text) =>
        new(state.Flow.Id, nodeId, at, kind, Clip(topic, FlowLimits.DebugExcerpt), Clip(text, FlowLimits.DebugExcerpt));

    private void Touch() => _version++;

    /// <summary>When an Every tick or a Repeat copy that came due at <paramref name="due"/> goes next.</summary>
    // From now rather than from when it was due, when the pump fell behind: a stall — a laptop that
    // slept, a debugger paused on the pump — is one late emission, never a burst of the ones that
    // were missed. For a Repeat that means its copies come later rather than all at once; it still
    // sends every one of them.
    private static DateTimeOffset NextAfter(DateTimeOffset due, TimeSpan interval, DateTimeOffset now)
    {
        var next = due + interval;
        return next > now ? next : now + interval;
    }

    /// <summary>One line, short enough to stand under a node.</summary>
    private static string Excerpt(string text)
    {
        var line = text.ReplaceLineEndings(" ");
        return line.Length <= FlowLimits.NoteLength ? line : line[..(FlowLimits.NoteLength - 1)] + "…";
    }

    private static string Clip(string text, int most) => text.Length <= most ? text : text[..most];

    // ---- state ----

    private sealed class FlowState(CompiledFlow flow, long generation, DateTimeOffset now)
    {
        private readonly Dictionary<string, NodeCounter> _counters = new(StringComparer.Ordinal);

        public CompiledFlow Flow { get; } = flow;
        public long Generation { get; } = generation;
        public Dictionary<string, int> Sequences { get; } = new(StringComparer.Ordinal);
        public EchoSet Echo { get; } = new();
        public TokenBucket Bucket { get; } = new(now);
        public long Faults { get; set; }
        public string? Fault { get; set; }

        public NodeCounter Counter(string id)
        {
            if (!_counters.TryGetValue(id, out var counter)) _counters[id] = counter = new NodeCounter();
            return counter;
        }

        /// <summary>A node's counter to read, which never makes one: a status read leaves no trace.</summary>
        public NodeCounter Peek(string id) =>
            _counters.TryGetValue(id, out var counter) ? counter : NodeCounter.Untouched;
    }

    private sealed class NodeCounter
    {
        // What a node nothing has happened to reads as. One instance for all of them, so it must
        // never be written: every write goes through FlowState.Counter, which never hands it out.
        public static readonly NodeCounter Untouched = new();

        public long Count;
        public long Errors;

        // The status line under a node on the canvas: one line of at most FlowLimits.NoteLength
        // characters. Anything that can run longer — a payload, a rendered topic, an alarm's
        // reason, an error that quotes one — goes through Excerpt on its way in.
        public string? Note;
        public readonly Dictionary<string, long> Outs = new(StringComparer.Ordinal);

        public void Out(string key) => Outs[key] = Outs.GetValueOrDefault(key) + 1;
    }

    /// <summary>What a flow has just published, so it does not answer itself.</summary>
    // A hash and not the payload: a thousand 64 KB payloads is 64 MB held to answer "was that me?".
    // Keyed by topic first, so the common arrival — a topic this flow never published to — costs a
    // dictionary miss and no hashing at all. Not consumed on a match: a broker may deliver one
    // publish twice to a client with overlapping subscriptions, and the second copy would loop.
    //
    // A hash of the bytes on both sides, never of text. What goes out is the rendered payload's
    // UTF-8; what comes back is text only when those bytes read as text, and base64 of them when
    // they do not (PayloadText) — a payload holding one control byte would otherwise never be
    // recognised, and a flow publishing it to its own filter would answer itself for ever.
    private sealed class EchoSet
    {
        private readonly Dictionary<string, List<(string Hash, DateTimeOffset Until)>> _byTopic = new(StringComparer.Ordinal);
        private readonly Queue<(string Topic, string Hash, DateTimeOffset Until)> _order = new();

        public void Remember(string topic, byte[] payload, DateTimeOffset now)
        {
            Expire(now);
            if (_order.Count >= FlowLimits.EchoFingerprints) Forget(_order.Dequeue());

            var entry = (Hash(payload), now + FlowLimits.EchoWindow);
            if (!_byTopic.TryGetValue(topic, out var list)) _byTopic[topic] = list = [];
            list.Add(entry);
            _order.Enqueue((topic, entry.Item1, entry.Item2));
        }

        public bool Heard(MqttMessage message, DateTimeOffset now)
        {
            Expire(now);
            if (!_byTopic.TryGetValue(message.Topic, out var list)) return false;

            var hash = Hash(BytesOf(message));
            return list.Exists(entry => entry.Hash == hash);
        }

        /// <summary>The bytes the broker delivered, as near as the message can say.</summary>
        private static byte[] BytesOf(MqttMessage message)
        {
            if (message.PayloadEncoding == MqttMessage.Base64)
            {
                try
                {
                    return Convert.FromBase64String(message.Payload);
                }
                catch (FormatException)
                {
                    // Marked base64 and not base64. The text is then the only thing to compare,
                    // and an arrival is never a reason for the runtime to throw.
                }
            }

            return Encoding.UTF8.GetBytes(message.Payload);
        }

        private void Expire(DateTimeOffset now)
        {
            while (_order.TryPeek(out var oldest) && oldest.Until <= now) Forget(_order.Dequeue());
        }

        private void Forget((string Topic, string Hash, DateTimeOffset Until) entry)
        {
            if (!_byTopic.TryGetValue(entry.Topic, out var list)) return;

            list.Remove((entry.Hash, entry.Until));
            if (list.Count == 0) _byTopic.Remove(entry.Topic);
        }

        private static string Hash(byte[] payload) => Convert.ToHexString(SHA1.HashData(payload));
    }

    /// <summary>Fifty publishes a second, refilled continuously, a second's worth at most.</summary>
    private sealed class TokenBucket(DateTimeOffset now)
    {
        private double _tokens = FlowLimits.PublishesPerSecond;
        private DateTimeOffset _at = now;

        public bool TryTake(DateTimeOffset now)
        {
            var elapsed = (now - _at).TotalSeconds;
            if (elapsed > 0)
            {
                _tokens = Math.Min(FlowLimits.PublishesPerSecond, _tokens + elapsed * FlowLimits.PublishesPerSecond);
                _at = now;
            }

            if (_tokens < 1) return false;

            _tokens -= 1;
            return true;
        }
    }

    private sealed record Scheduled(string FlowId, long Generation, string NodeId, FlowMessage Message, int Remaining)
    {
        public static Scheduled Tick(FlowState state, EveryNode every) =>
            new(state.Flow.Id, state.Generation, every.Id, new FlowMessage(every.Topic, every.Payload), 0);
    }

    private sealed class Run(FlowState state, DateTimeOffset now, Collector into)
    {
        public FlowState State { get; } = state;
        public DateTimeOffset Now { get; } = now;
        public Collector Into { get; } = into;
        public int Steps { get; set; }
        public bool Exhausted { get; set; }
    }

    private sealed class Collector
    {
        public List<FlowPublish> Publishes { get; } = [];
        public List<Alert> Raised { get; } = [];
        public List<Alert> Resolved { get; } = [];
        public List<FlowDebugEntry> Debug { get; } = [];

        public FlowOutcome Outcome() =>
            Publishes.Count == 0 && Raised.Count == 0 && Resolved.Count == 0 && Debug.Count == 0
                ? FlowOutcome.Empty
                : new FlowOutcome(Publishes, Raised, Resolved, Debug);
    }
}
