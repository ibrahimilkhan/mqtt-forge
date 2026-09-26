using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MqttForge.Application.Alerts;
using MqttForge.Application.Alerts.Conditions;
using MqttForge.Domain;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Flows;

/// <summary>Turns a drawn flow into a runnable one, or says everything that is wrong with it.</summary>
// Everything, not the first thing. The console marks every refused node at once, and a compiler
// that stopped at the first problem would have somebody deploy five times to find five typos.
//
// It is also the only reader of a node's settings. The store keeps them as JSON and the runtime
// only ever sees what this made of them, so a setting's meaning — its default, its range, its
// sentence when it is wrong — is written down once, here.
public static partial class FlowCompiler
{
    /// <summary>What an id may look like: short, and safe in a path, a topic and a file.</summary>
    public static Regex IdPattern { get; } = IdRegex();

    public static FlowCompileResult Compile(Flow flow, string alertTopicPrefix)
    {
        var problems = new List<FlowProblem>();

        if (flow.Id is null || !IdPattern.IsMatch(flow.Id))
            problems.Add(new(null, null, "A flow's id is 1 to 40 letters, digits, '-' or '_'."));

        var name = flow.Name?.Trim() ?? "";
        if (name.Length is 0 or > FlowLimits.NameLength)
            problems.Add(new(null, null, $"Name the flow, in at most {FlowLimits.NameLength} characters."));

        // STJ only promises Nodes/Edges are never null at compile time: a hand-edited flows.json,
        // or a PUT body built by hand rather than by the console, can still leave either out, or
        // leave a hole in the middle of one. None of that is a reason to throw instead of answering
        // with the same kind of problem list a bad node or a bad wire gets.
        var rawNodes = flow.Nodes ?? [];
        var rawEdges = flow.Edges ?? [];

        if (rawNodes.Count > FlowLimits.NodesPerFlow)
            problems.Add(new(null, null, $"A flow holds at most {FlowLimits.NodesPerFlow} nodes."));

        if (rawEdges.Count > FlowLimits.EdgesPerFlow)
            problems.Add(new(null, null, $"A flow holds at most {FlowLimits.EdgesPerFlow} wires."));

        // Types are kept for every node with a usable id, compiled or not, so a wire to a node whose
        // settings are wrong is judged on its ports and is not also reported as dangling.
        var types = new Dictionary<string, string>(StringComparer.Ordinal);
        var nodes = new Dictionary<string, CompiledNode>(StringComparer.Ordinal);

        foreach (var node in rawNodes)
        {
            if (node is null)
            {
                problems.Add(new(null, null, "A node in this flow is empty."));
                continue;
            }

            if (node.Id is null || !IdPattern.IsMatch(node.Id))
            {
                problems.Add(new(null, null, "A node's id is 1 to 40 letters, digits, '-' or '_'."));
                continue;
            }

            if (!types.TryAdd(node.Id, node.Type))
            {
                problems.Add(new(node.Id, null, "Two nodes share this id."));
                continue;
            }

            var settings = new Settings(node.Config);
            var compiled = Node(node, settings, alertTopicPrefix, out var problem);

            if (problem is not null) problems.Add(new(node.Id, null, problem));
            else if (compiled is not null) nodes.Add(node.Id, compiled);
        }

        var wires = new List<FlowEdge>();
        var edgeIds = new HashSet<string>(StringComparer.Ordinal);
        var joined = new HashSet<(string, string, string, string)>();

        foreach (var edge in rawEdges)
        {
            if (edge is null)
            {
                problems.Add(new(null, null, "A wire in this flow is empty."));
                continue;
            }

            var problem = Wire(edge, types, edgeIds, joined);
            if (problem is not null) problems.Add(new(null, edge.Id, problem));
            else wires.Add(edge);
        }

        if (GoesRound(types.Keys, wires))
            problems.Add(new(null, null,
                "The wires go round in a circle. Repeat things with Every, For each or Repeat instead."));

        if (problems.Count > 0) return new FlowCompileResult(null, problems);

        foreach (var wire in wires)
            nodes[wire.From].Attach(wire.FromPort, new FlowTarget(nodes[wire.To], wire.ToPort));

        return new FlowCompileResult(new CompiledFlow
        {
            Id = flow.Id!,
            Name = name,
            Enabled = flow.Enabled,
            Fingerprint = Fingerprint(flow),
            Nodes = nodes,
            Inputs = [.. nodes.Values.OfType<MqttInNode>()],
            Timers = [.. nodes.Values.OfType<EveryNode>()],
        }, []);
    }

    /// <summary>Every flow in a file. A flow that does not compile is kept, reported, and not run.</summary>
    // Kept rather than dropped because the file is a record: a hand-edited flow with a typo in it
    // is still somebody's work, and the next deploy of a different flow must not take it away.
    public static FlowSet CompileAll(IReadOnlyList<Flow> flows, string alertTopicPrefix)
    {
        var compiled = new List<CompiledFlow>();
        var problems = new List<FlowSetProblem>();

        foreach (var flow in flows)
        {
            var result = Compile(flow, alertTopicPrefix);

            if (result.Flow is not null) compiled.Add(result.Flow);
            else problems.AddRange(result.Problems.Select(problem => new FlowSetProblem(flow.Id, problem)));
        }

        return new FlowSet(compiled, [.. flows.Select(flow => flow.Id)], problems);
    }

    private static CompiledNode? Node(FlowNode node, Settings settings, string prefix, out string? problem)
    {
        problem = null;

        switch (node.Type)
        {
            case FlowPorts.MqttIn:
            {
                var filter = settings.Text("filter").Trim();

                if (!TopicFilterMatch.IsValidFilter(filter))
                    problem = "Write a topic filter, like plant/+/temp.";
                else if (AlertTopicPrefix.Covers(filter, prefix))
                    problem = $"This filter reaches into {prefix}, where alarms are published. A flow may not listen there.";

                return new MqttInNode(node.Id, filter, settings.Bool("replay"));
            }

            case FlowPorts.Every:
            {
                var interval = Seconds(settings.Number("seconds") ?? 0);
                if (interval < FlowLimits.MinInterval || interval > FlowLimits.MaxEvery)
                    problem = "Every needs an interval between 0.1 seconds and 24 hours.";

                return new EveryNode(node.Id, interval, settings.Text("topic"), settings.Text("payload"));
            }

            case FlowPorts.Inject:
                return new InjectNode(node.Id, settings.Text("topic"), settings.Text("payload"));

            case FlowPorts.If:
            {
                var test = Test(settings, out problem);
                return test is null ? null : new IfNode(node.Id, settings.Text("field").Trim(), test);
            }

            case FlowPorts.ForEach:
                return new ForEachNode(node.Id, settings.Text("field").Trim());

            case FlowPorts.Repeat:
            {
                var count = settings.Number("count") is { } n ? (int)Math.Round(n) : 0;
                var interval = Seconds(settings.Number("seconds") ?? 0);

                if (count is < 1 or > FlowLimits.RepeatCount)
                    problem = $"Repeat between 1 and {FlowLimits.RepeatCount} times.";
                else if (interval != TimeSpan.Zero &&
                         (interval < FlowLimits.MinInterval || interval > FlowLimits.MaxRepeatInterval))
                    problem = "Leave the interval at 0 to send every copy at once, or give 0.1 seconds to an hour.";

                return new RepeatNode(node.Id, count, interval);
            }

            case FlowPorts.Alarm:
                return Alarm(node.Id, settings, prefix, out problem);

            case FlowPorts.Publish:
            {
                var topicText = settings.Text("topic").Trim();
                var topic = FlowTemplate.Parse(topicText, out var topicProblem);
                var payload = FlowTemplate.Parse(settings.Text("payload"), out var payloadProblem);
                var qos = (int)(settings.Number("qos") ?? 0);

                if (topicText.Length == 0)
                    problem = "Give the topic to publish to.";
                else if (topicText.Length > FlowLimits.TopicTemplateLength)
                    problem = $"A topic is at most {FlowLimits.TopicTemplateLength} characters.";
                else if (topicProblem is not null)
                    problem = topicProblem;
                else if (topic.LiteralText.AsSpan().IndexOfAny('+', '#') >= 0)
                    problem = "A topic to publish to cannot hold + or #.";
                else if (payloadProblem is not null)
                    problem = payloadProblem;
                else if (Encoding.UTF8.GetByteCount(settings.Text("payload")) > FlowLimits.PayloadBytes)
                    problem = "A payload is at most 64 KB.";
                else if (qos is < 0 or > 2)
                    problem = "QoS is 0, 1 or 2.";

                return new PublishNode(node.Id, topic, payload, qos, settings.Bool("retain"));
            }

            case FlowPorts.Debug:
                return new DebugNode(node.Id);

            default:
                problem = $"This build does not know a node called '{node.Type}'.";
                return null;
        }
    }

    private static IfTest? Test(Settings settings, out string? problem)
    {
        problem = null;
        var value = settings.Text("value");
        var value2 = settings.Text("value2");

        switch (settings.Text("test"))
        {
            case "gt" or "gte" or "lt" or "lte":
                if (PayloadValue.AsReading(value.Trim()) is not { } number)
                {
                    problem = "Give the number to compare with.";
                    return null;
                }

                return new CompareTest(settings.Text("test"), number);

            case "eq":
                return new EqualsTest(negate: false, value);

            case "neq":
                return new EqualsTest(negate: true, value);

            case "between":
                if (PayloadValue.AsReading(value.Trim()) is not { } low ||
                    PayloadValue.AsReading(value2.Trim()) is not { } high || low > high)
                {
                    problem = "Give two numbers, the lower one first.";
                    return null;
                }

                return new BetweenTest(low, high);

            case "matches":
                try
                {
                    return new MatchesTest(CompiledPatterns.Compile(value));
                }
                catch (ArgumentException ex)
                {
                    problem = $"This pattern does not compile: {ex.Message}";
                    return null;
                }

            case "oneOf":
            {
                var values = value.Split(',').Select(one => one.Trim()).Where(one => one.Length > 0).ToHashSet(StringComparer.Ordinal);
                if (values.Count == 0)
                {
                    problem = "List at least one value, separated by commas.";
                    return null;
                }

                return new OneOfTest(values);
            }

            case "exists":
                return new ExistsTest();

            default:
                problem = "Pick a test.";
                return null;
        }
    }

    private static AlarmNode? Alarm(string id, Settings settings, string prefix, out string? problem)
    {
        problem = null;
        var name = settings.Text("name").Trim();

        if (name.Length is 0 or > FlowLimits.NameLength)
        {
            problem = $"Name the alarm, in at most {FlowLimits.NameLength} characters.";
            return null;
        }

        AlertSeverity severity;
        switch (settings.Text("severity"))
        {
            case "info": severity = AlertSeverity.Info; break;
            case "warn": severity = AlertSeverity.Warn; break;
            case "critical": severity = AlertSeverity.Critical; break;
            default:
                problem = "Pick a level: info, warn or critical.";
                return null;
        }

        // A reason left blank says the alarm's own name, which is at least a sentence.
        var reasonText = settings.Text("reason").Trim();
        var reason = FlowTemplate.Parse(reasonText.Length == 0 ? name : reasonText, out problem);
        if (problem is not null) return null;

        // Screen always: an alarm nobody can see is not one. The rest are asked for by the node.
        var actions = new List<AlertAction> { new ScreenAction() };
        if (settings.Bool("sound")) actions.Add(new SoundAction());

        var webhook = settings.Text("webhook").Trim();
        if (webhook.Length > 0)
        {
            if (!Uri.TryCreate(webhook, UriKind.Absolute, out var url) || url.Scheme is not ("http" or "https"))
            {
                problem = "The webhook needs an http or https address.";
                return null;
            }

            actions.Add(new WebhookAction(webhook, new Dictionary<string, string>()));
        }

        if (settings.Bool("publish"))
        {
            var topic = settings.Text("publishTopic").Trim();
            if (topic.Length > 0 && !AlertTopicPrefix.Inside(topic, prefix))
            {
                problem = $"An alarm's own topic has to stay under {prefix}. Leave it empty for the usual place.";
                return null;
            }

            var qos = (int)(settings.Number("qos") ?? 1);
            if (qos is < 0 or > 2)
            {
                problem = "QoS is 0, 1 or 2.";
                return null;
            }

            actions.Add(new PublishAction(topic.Length == 0 ? null : topic, qos, settings.Bool("retain")));
        }

        return new AlarmNode(id, name, severity, reason, settings.Text("value").Trim(), actions);
    }

    private static string? Wire(
        FlowEdge edge, IReadOnlyDictionary<string, string> types, ISet<string> ids,
        ISet<(string, string, string, string)> joined)
    {
        if (edge.Id is null || !IdPattern.IsMatch(edge.Id) || !ids.Add(edge.Id))
            return "A wire needs its own id.";

        // Dictionary.TryGetValue throws on a null key rather than answering false, so a null
        // From or To has to be turned away before it ever reaches one — the same problem a wire
        // to an id nothing declared gets, since to whoever drew this a missing end is no different.
        if (edge.From is null || edge.To is null ||
            !types.TryGetValue(edge.From, out var from) || !types.TryGetValue(edge.To, out var to))
            return "This wire does not start and end on nodes.";

        if (edge.From == edge.To)
            return "A wire cannot come back to its own node.";

        if (!FlowPorts.Outs(from).Contains(edge.FromPort))
            return $"This node has no output called '{edge.FromPort}'.";

        if (!FlowPorts.Ins(to).Contains(edge.ToPort))
            return $"That node has no input called '{edge.ToPort}'.";

        if (!joined.Add((edge.From, edge.FromPort, edge.To, edge.ToPort)))
            return "Two wires join the same ports.";

        return null;
    }

    // Kahn's algorithm: whatever is left once every node with no way in has been taken away is a
    // circle. Only wires that passed Wire are counted, so a broken wire is not also a circle.
    private static bool GoesRound(IEnumerable<string> ids, IReadOnlyList<FlowEdge> wires)
    {
        var incoming = ids.ToDictionary(id => id, _ => 0, StringComparer.Ordinal);
        foreach (var wire in wires) incoming[wire.To]++;

        var ready = new Queue<string>(incoming.Where(pair => pair.Value == 0).Select(pair => pair.Key));
        var taken = 0;

        while (ready.Count > 0)
        {
            var id = ready.Dequeue();
            taken++;

            foreach (var wire in wires)
                if (wire.From == id && --incoming[wire.To] == 0)
                    ready.Enqueue(wire.To);
        }

        return taken < incoming.Count;
    }

    private static string Fingerprint(Flow flow)
    {
        // Reached only once Compile has found no problem, which for Nodes/Edges means neither is
        // null and neither holds a null element — but the list itself can still be the null STJ
        // leaves it as when a hand-edited file omits the property, so it is coalesced again here
        // rather than trusted a second time from a flow this method never validated itself.
        var shape = JsonSerializer.Serialize(new
        {
            flow.Name,
            Nodes = (flow.Nodes ?? []).Select(node => new { node.Id, node.Type, Config = node.Config.ValueKind == JsonValueKind.Undefined ? "{}" : node.Config.GetRawText() }),
            Edges = flow.Edges ?? [],
        }, FlowJson.Options);

        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(shape)));
    }

    private static TimeSpan Seconds(double seconds) =>
        double.IsFinite(seconds) && seconds is >= 0 and <= 1e7 ? TimeSpan.FromSeconds(seconds) : TimeSpan.MaxValue;

    [GeneratedRegex("^[A-Za-z0-9_-]{1,40}$", RegexOptions.CultureInvariant)]
    private static partial Regex IdRegex();

    /// <summary>A node's settings, read leniently: a wrong type is the same as a missing value.</summary>
    // Lenient because the editor writes numbers from text boxes, and a number that arrives as
    // "0.5" is the number 0.5 to anyone who typed it.
    private readonly struct Settings(JsonElement config)
    {
        private JsonElement? Get(string name) =>
            config.ValueKind == JsonValueKind.Object && config.TryGetProperty(name, out var value) ? value : null;

        public string Text(string name) => Get(name) switch
        {
            { ValueKind: JsonValueKind.String } value => value.GetString() ?? "",
            { ValueKind: JsonValueKind.Number } value => value.GetRawText(),
            _ => "",
        };

        public bool Bool(string name) => Get(name) is { ValueKind: JsonValueKind.True };

        public double? Number(string name) => Get(name) switch
        {
            { ValueKind: JsonValueKind.Number } value when value.TryGetDouble(out var number) => number,
            { ValueKind: JsonValueKind.String } value when double.TryParse(
                value.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var number) => number,
            _ => null,
        };
    }
}
