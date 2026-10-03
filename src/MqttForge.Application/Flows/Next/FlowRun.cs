namespace MqttForge.Application.Flows.Next;

/// <summary>One run's state: where it is, what it carries, what it has done. Only the runtime touches it.</summary>
// A program counter over a compiled flowchart — the node it enters next, and by which way in — with
// the one message it carries, its variables, the state of every loop it is in, and a queue of
// messages for each of its MQTT in nodes, filled from the moment it starts.
internal sealed class FlowRun
{
    private readonly Dictionary<string, NodeCounter> _counters = new(StringComparer.Ordinal);

    public FlowRun(CompiledFlow flow, FlowRunKind kind, DateTimeOffset now)
    {
        Flow = flow;
        Key = new FlowRunKey(flow.Id, kind);
        At = flow.Start;
        Variables = flow.Variables.ToDictionary(variable => variable.Name, variable => variable.Value, StringComparer.Ordinal);
        Bucket = new TokenBucket(now);

        foreach (var input in flow.Inputs) Queues[input.Id] = new Queue<FlowMessage>();
    }

    public CompiledFlow Flow { get; }
    public FlowRunKey Key { get; }

    public FlowRunState State { get; set; } = FlowRunState.Running;

    /// <summary>The node the run enters next.</summary>
    public CompiledNode At { get; set; }

    /// <summary>The way into <see cref="At"/>: a loop tells "in" from "next" by it.</summary>
    public string AtPort { get; set; } = "";

    /// <summary>The run waited at <see cref="At"/> and takes up there, rather than entering it anew.</summary>
    public bool Resuming { get; set; }

    public FlowMessage Message { get; set; } = new("", "", 0);
    public Dictionary<string, string> Variables { get; }
    public Dictionary<string, LoopState> Loops { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, Queue<FlowMessage>> Queues { get; } = new(StringComparer.Ordinal);

    /// <summary>When the Wait the run is in ends.</summary>
    public DateTimeOffset? WakeAt { get; set; }

    /// <summary>How long that Wait is, so a clock set back cannot make it longer.</summary>
    public TimeSpan WaitFor { get; set; }

    /// <summary>How many times the run has waited or read a message: the forever-loop guard's measure of progress.</summary>
    public long Pauses { get; set; }

    /// <summary>A slow step ended the run's share of this turn early.</summary>
    public bool YieldNow { get; set; }

    public FlowEchoSet Echo { get; } = new();
    public TokenBucket Bucket { get; }

    /// <summary>When each Sound, Notify and Webhook node last did its job.</summary>
    public Dictionary<string, DateTimeOffset> ChannelAt { get; } = new(StringComparer.Ordinal);

    public string? Fault { get; set; }

    /// <summary>Going or waiting: not finished at an End and not stopped.</summary>
    public bool Live => State is FlowRunState.Running or FlowRunState.Waiting;

    public NodeCounter Counter(string id)
    {
        if (!_counters.TryGetValue(id, out var counter)) _counters[id] = counter = new NodeCounter();
        return counter;
    }

    /// <summary>A node's counter to read, which never makes one: a status read leaves no trace.</summary>
    public NodeCounter Peek(string id) => _counters.TryGetValue(id, out var counter) ? counter : NodeCounter.Untouched;

    /// <summary>Lets go of every message the run's MQTT in nodes are holding.</summary>
    // For a run that has ended, which reads none of them, and stays to be read itself until it is
    // replaced: for an active run, that can be the life of the process, with a thousand payloads held
    // for each MQTT in node it had not reached.
    public void ForgetQueued()
    {
        foreach (var queue in Queues.Values)
        {
            queue.Clear();
            queue.TrimExcess();
        }
    }
}

/// <summary>A loop the run is in: what it went in with, how many turns, which one this is.</summary>
internal sealed class LoopState(FlowMessage entry, long? total, IReadOnlyList<string>? items)
{
    /// <summary>The message the loop was entered with; every turn starts from it, and done hands it back.</summary>
    public FlowMessage Entry { get; } = entry;

    /// <summary>How many turns, or null for forever.</summary>
    public long? Total { get; } = total;

    /// <summary>For each's elements, or null for a For.</summary>
    public IReadOnlyList<string>? Items { get; } = items;

    public long Turn { get; set; } = 1;

    /// <summary>The run's <see cref="FlowRun.Pauses"/> when this turn began.</summary>
    public long PausesAtTurn { get; set; }
}

internal sealed class NodeCounter
{
    // What a node nothing has happened to reads as. One instance for all of them, so it must never be
    // written: every write goes through FlowRun.Counter, which never hands it out.
    public static readonly NodeCounter Untouched = new();

    public long Count;
    public long Errors;

    // The status line under a node on the canvas: one line of at most FlowLimits.NoteLength
    // characters. Anything that can run longer goes through the runtime's Excerpt on its way in.
    public string? Note;
    public readonly Dictionary<string, long> Outs = new(StringComparer.Ordinal);

    public void Out(string key) => Outs[key] = Outs.GetValueOrDefault(key) + 1;
}

/// <summary>Fifty publishes a second, refilled continuously, a second's worth at most.</summary>
internal sealed class TokenBucket(DateTimeOffset now)
{
    private double _tokens = FlowLimits.PublishesPerSecond;
    private DateTimeOffset _at = now;

    public bool TryTake(DateTimeOffset now)
    {
        var elapsed = (now - _at).TotalSeconds;
        if (elapsed > 0)
            _tokens = Math.Min(FlowLimits.PublishesPerSecond, _tokens + elapsed * FlowLimits.PublishesPerSecond);

        // Moved on a clock set back as well, which counts as no time gone by. Left where it was, the
        // bucket would refill nothing until the clock had caught up with it again, and every publish
        // until then — an hour of them, for a clock an hour fast that was put right — would be refused
        // as over the rate.
        _at = now;

        if (_tokens < 1) return false;

        _tokens -= 1;
        return true;
    }
}
