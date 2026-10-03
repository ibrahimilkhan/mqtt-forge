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

/// <summary>Turns a drawn flowchart into a runnable one, or says everything that is wrong with it.</summary>
// Everything, not the first thing: the console marks every refused node at once, and a compiler that
// stopped at the first problem would have somebody press Test five times to find five mistakes. So a
// node whose settings are wrong still takes part in the checks of the drawing — its wires, whether
// Start reaches it — and both kinds of problem are said together.
//
// It is also the only reader of a node's settings. The store keeps them as JSON and the runtime only
// ever sees what this made of them, so a setting's meaning — its default, its range, its sentence
// when it is wrong — is written down once, here.
public static partial class FlowCompiler
{
    /// <summary>What an id may look like: short, and safe in a path, a topic and a file.</summary>
    public static Regex IdPattern { get; } = IdRegex();

    public static FlowCompileResult Compile(Flow flow, string alertTopicPrefix)
    {
        var problems = new List<FlowProblem>();

        if (!IdPattern.IsMatch(flow.Id))
            problems.Add(new(null, null, "A flow's id is 1 to 40 letters, digits, '-' or '_'."));

        var name = flow.Name.Trim();
        if (name.Length is 0 or > FlowLimits.NameLength)
            problems.Add(new(null, null, $"Name the flow, in at most {FlowLimits.NameLength} characters."));

        // Refused on the counts alone, before one node is read: everything past this grows with the
        // flow, and a flow fifty times over the limit must cost nothing to refuse.
        var nodesOver = flow.Nodes.Count > FlowLimits.NodesPerFlow;
        var edgesOver = flow.Edges.Count > FlowLimits.EdgesPerFlow;

        if (nodesOver) problems.Add(new(null, null, $"A flow holds at most {FlowLimits.NodesPerFlow} nodes."));
        if (edgesOver) problems.Add(new(null, null, $"A flow holds at most {FlowLimits.EdgesPerFlow} wires."));
        if (nodesOver || edgesOver) return new FlowCompileResult(null, problems);

        var declared = Variables(flow.Variables, problems);

        // Types are kept for every node with a usable id, compiled or not, so the drawing is judged
        // whole: a wire to a node whose settings are wrong is still a wire, and still counts.
        var types = new Dictionary<string, string>(StringComparer.Ordinal);
        var order = new List<string>();
        var nodes = new Dictionary<string, CompiledNode>(StringComparer.Ordinal);

        foreach (var node in flow.Nodes)
        {
            if (node is null)
            {
                problems.Add(new(null, null, "A node in this flow is empty."));
                continue;
            }

            if (!IdPattern.IsMatch(node.Id))
            {
                problems.Add(new(null, null, "A node's id is 1 to 40 letters, digits, '-' or '_'."));
                continue;
            }

            if (!types.TryAdd(node.Id, node.Type))
            {
                problems.Add(new(node.Id, null, "Two nodes share this id."));
                continue;
            }

            order.Add(node.Id);

            // The whole of a node's settings is judged, and before one of them is read. Text that cannot be
            // read is not always in a setting this kind of node reads — it can be in a box the pane hides, in
            // a name, or in a node that reads nothing — and it is written out again all the same: by the
            // fingerprint below, and by the file the flow is kept in, where it is an exception and not a
            // sentence. Said here it is said on the node, like any setting that cannot be used, and the
            // node's wires and the rest of the drawing are still judged with it.
            //
            // Said of the node's settings and not of one setting, for the same reason: the reader may find
            // no box that shows the text, so the way out is one that works wherever it is.
            CompiledNode? compiled = null;
            string? problem = null;

            if (Settings.TryRead(node.Config, out var settings))
                compiled = Node(node, settings, alertTopicPrefix, declared, out problem);
            else
                problem = "This node's settings hold text that cannot be read. Retype what you can, or delete the node and draw it again.";

            if (problem is not null) problems.Add(new(node.Id, null, problem));
            else if (compiled is not null) nodes.Add(node.Id, compiled);
        }

        // A Clear alarm closes the alarm of a Raise alarm node of this flow, named by that node's id.
        // Judged against every node there is, so a Raise alarm with a mistake of its own is still the
        // one it names, and that mistake is said once, on its own node.
        foreach (var clear in nodes.Values.OfType<AlarmClearNode>().ToList())
        {
            if (types.GetValueOrDefault(clear.Alarm) == FlowPorts.AlarmRaise) continue;

            problems.Add(new(clear.Id, null, clear.Alarm.Length == 0
                ? "Pick the alarm this clears."
                : "The alarm this clears is not in this flow any more. Pick another."));
            nodes.Remove(clear.Id);
        }

        var wires = new List<FlowEdge>();
        var edgeIds = new HashSet<string>(StringComparer.Ordinal);
        var joined = new HashSet<(string, string, string, string)>();

        foreach (var edge in flow.Edges)
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

        var start = Structure(types, order, wires, nodes, problems);

        if (problems.Count > 0 || start is null) return new FlowCompileResult(null, problems);

        foreach (var wire in wires)
            nodes[wire.From].Attach(wire.FromPort, new FlowTarget(nodes[wire.To], wire.ToPort));

        return new FlowCompileResult(new CompiledFlow
        {
            Id = flow.Id,
            Name = name,
            Enabled = flow.Enabled,
            Fingerprint = Fingerprint(flow),
            Nodes = nodes,
            Start = (StartNode)nodes[start],
            Inputs = [.. nodes.Values.OfType<MqttInNode>()],
            Variables = flow.Variables,
        }, []);
    }

    /// <summary>Every flow in a file. A flow that does not compile is kept, reported, and not run.</summary>
    // Kept rather than dropped because the file is a record: a hand-edited flow with a typo in it is
    // still somebody's work, and the next save of a different flow must not take it away.
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

    /// <summary>The flow's variables, judged; and the names it declares, for every reference to one.</summary>
    private static HashSet<string> Variables(IReadOnlyList<FlowVariable> variables, List<FlowProblem> problems)
    {
        // Past the limit only the count is said, as it is for nodes and wires: what is wrong with each variable
        // can wait until the list is cut down, and said now it would bury the one sentence that matters under
        // fifty more. Their names are still the ones the nodes read, so that no node is told a variable it
        // reads is missing when it is there.
        if (variables.Count > FlowLimits.Variables)
        {
            problems.Add(new(null, null, $"A flow has at most {FlowLimits.Variables} variables."));
            return new HashSet<string>(
                variables.Where(variable => variable is not null).Select(variable => variable.Name), StringComparer.Ordinal);
        }

        var names = new HashSet<string>(StringComparer.Ordinal);

        foreach (var variable in variables)
        {
            if (variable is null)
            {
                problems.Add(new(null, null, "A variable in this flow is empty."));
                continue;
            }

            if (!FlowVariables.IsName(variable.Name))
                problems.Add(new(null, null,
                    $"'{FlowTemplate.Clip(variable.Name, 40)}' is not a variable's name: a letter or _, then letters, digits or _, 40 at most."));
            else if (!names.Add(variable.Name))
                problems.Add(new(null, null, $"Two variables are called {variable.Name}."));

            if (Encoding.UTF8.GetByteCount(variable.Value) > FlowLimits.VariableBytes)
                problems.Add(new(null, null, $"{FlowTemplate.Clip(variable.Name, 40)} starts at a value over 64 KB."));
        }

        return names;
    }

    private static CompiledNode? Node(
        FlowNode node, Settings settings, string prefix, IReadOnlySet<string> declared, out string? problem)
    {
        problem = null;

        switch (node.Type)
        {
            case FlowPorts.Start:
                return new StartNode(node.Id);

            case FlowPorts.End:
                return new EndNode(node.Id);

            case FlowPorts.MqttIn:
            {
                var filter = settings.Text("filter").Trim();

                if (TopicFilterMatch.FilterProblem(filter) is { } wrong)
                    problem = wrong;
                else if (AlertTopicPrefix.Covers(filter, prefix))
                    problem = $"This filter reaches into {prefix}, where alarms are published. A flow may not listen there.";

                return new MqttInNode(node.Id, filter, settings.Bool("replay"));
            }

            case FlowPorts.If:
                return If(node.Id, settings, declared, out problem);

            case FlowPorts.For:
            {
                // A forever loop counts nothing, and the pane hides times while forever is ticked but keeps what
                // was typed there: that is taken as empty, so it can neither refuse the node nor be carried into it
                // — unless it is text that cannot be read at all, which Compile refuses before this is reached.
                var forever = settings.Bool("forever");
                var timesText = forever ? "" : settings.Text("times");

                // Judged before it is parsed, so a box of a million characters costs nothing to refuse; why
                // there is a limit at all is said where it is kept, in FlowLimits.TextTemplateLength.
                if (timesText.Length > FlowLimits.TextTemplateLength)
                {
                    problem = $"Times is at most {FlowLimits.TextTemplateLength} characters.";
                    return null;
                }

                var times = Template(timesText, declared, out problem);

                if (problem is null && !forever)
                {
                    if (timesText.Trim().Length == 0)
                        problem = "Say how many times, or tick forever.";
                    else if (times.IsLiteral && FlowNumbers.Times(times.LiteralText) is null)
                        problem = $"Times is a whole number from 0 to {FlowLimits.ForTimes.ToString("N0", CultureInfo.InvariantCulture)}.";
                }

                return new ForNode(node.Id, times, forever);
            }

            case FlowPorts.ForEach:
                return new ForEachNode(node.Id, Value(settings.Text("array"), declared, out problem));

            case FlowPorts.Wait:
            {
                var secondsText = settings.Text("seconds");

                if (secondsText.Length > FlowLimits.TextTemplateLength)
                {
                    problem = $"Seconds is at most {FlowLimits.TextTemplateLength} characters.";
                    return null;
                }

                var seconds = Template(secondsText, declared, out problem);

                if (problem is null)
                {
                    if (secondsText.Trim().Length == 0)
                        problem = "Say how many seconds to wait.";
                    else if (seconds.IsLiteral && FlowNumbers.Seconds(seconds.LiteralText) is null)
                        problem = "Wait between 0.1 seconds and 24 hours (86,400 seconds).";
                }

                return new WaitNode(node.Id, seconds);
            }

            case FlowPorts.Set:
            {
                var variable = settings.Text("variable").Trim();
                if (variable.Length == 0)
                {
                    problem = "Pick the variable to set.";
                    return null;
                }

                if (!declared.Contains(variable))
                {
                    problem = NoSuchVariable(variable);
                    return null;
                }

                // Held, and said, as an If's value is: the limit is on what is written in the box, and what it
                // fills in can still take the variable to the 64 KB a variable may hold.
                var valueText = settings.Text("value");
                if (valueText.Length > FlowLimits.TextTemplateLength)
                {
                    problem = $"A value is at most {FlowLimits.TextTemplateLength} characters.";
                    return null;
                }

                return new SetNode(node.Id, variable, Template(valueText, declared, out problem));
            }

            case FlowPorts.Publish:
            {
                var topicText = settings.Text("topic").Trim();
                var topic = Template(topicText, declared, out var topicProblem);
                var payloadText = settings.Text("payload");
                var payload = Template(payloadText, declared, out var payloadProblem);
                // Judged as the number that was written and made whole only once it is one of the three: a
                // cast first would take 1.5 for 1 and publish at a QoS nobody chose.
                var qos = settings.Number("qos") ?? 0;

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
                else if (PayloadProblem(payloadText, "A payload") is { } tooLarge)
                    problem = tooLarge;
                else if (qos is not (0 or 1 or 2))
                    problem = "QoS is 0, 1 or 2.";

                return new PublishNode(node.Id, topic, payload, (int)qos, settings.Bool("retain"));
            }

            case FlowPorts.Debug:
                return new DebugNode(node.Id);

            case FlowPorts.AlarmRaise:
                return AlarmRaise(node.Id, settings, declared, out problem);

            case FlowPorts.AlarmClear:
                return new AlarmClearNode(node.Id, settings.Text("alarm").Trim());

            case FlowPorts.Sound:
            {
                var level = Level(settings.Text("level"), out problem);
                return new SoundNode(node.Id, level);
            }

            case FlowPorts.Notify:
            {
                var text = settings.Text("text").Trim();
                if (text.Length == 0)
                {
                    problem = "Write what the notice says.";
                    return null;
                }

                if (text.Length > FlowLimits.TextTemplateLength)
                {
                    problem = $"Write the notice in at most {FlowLimits.TextTemplateLength} characters; " +
                              $"only the first {FlowLimits.NoticeLength} are shown.";
                    return null;
                }

                var template = Template(text, declared, out problem);
                if (problem is not null) return null;

                var level = Level(settings.Text("level"), out problem);
                return new NotifyNode(node.Id, template, level);
            }

            case FlowPorts.Webhook:
            {
                var url = settings.Text("url").Trim();
                if (url.Length == 0)
                {
                    problem = "Give the address to post to.";
                    return null;
                }

                if (url.Length > FlowLimits.UrlLength || !Uri.TryCreate(url, UriKind.Absolute, out var address) ||
                    address.Scheme is not ("http" or "https"))
                {
                    problem = "The address has to be an absolute http:// or https:// address.";
                    return null;
                }

                // The alert rules' refusal, for its reason: a password in an address is sent on to every
                // redirect and written into every log on the way.
                if (!string.IsNullOrEmpty(address.UserInfo))
                {
                    problem = "An address cannot carry a username or password.";
                    return null;
                }

                // An empty body sends the message as it is, which is what a webhook wired after an
                // alarm's "raised" wants: the alarm.
                var bodyText = settings.Text("body");
                if (bodyText.Trim().Length == 0) bodyText = "{{payload}}";

                if (PayloadProblem(bodyText, "A body") is { } tooLarge)
                {
                    problem = tooLarge;
                    return null;
                }

                return new WebhookNode(node.Id, url, Template(bodyText, declared, out problem));
            }

            default:
                problem = $"This build does not know a node called '{node.Type}'.";
                return null;
        }
    }

    private static IfNode? If(string id, Settings settings, IReadOnlySet<string> declared, out string? problem)
    {
        var field = Value(settings.Text("field"), declared, out problem);
        if (problem is not null) return null;

        // The test is read before the values because it says which of them there are: the pane shows
        // value for every test but exists and value2 for between alone, and keeps what was typed in a box
        // it hides. A box the test does not read is taken as empty, so what was left in it — a variable
        // deleted since, say — cannot refuse the node with a sentence about a box nobody can see. Unless
        // what was left is text that cannot be read at all, which refuses the node before this is reached:
        // see Compile, where every node's settings are judged whole.
        var test = settings.Text("test");
        var valueText = test == "exists" ? "" : settings.Text("value");
        var value2Text = test == "between" ? settings.Text("value2") : "";

        if (valueText.Length > FlowLimits.TextTemplateLength || value2Text.Length > FlowLimits.TextTemplateLength)
        {
            problem = $"A value is at most {FlowLimits.TextTemplateLength} characters.";
            return null;
        }

        var value = Template(valueText, declared, out problem);
        if (problem is not null) return null;

        var value2 = Template(value2Text, declared, out problem);
        if (problem is not null) return null;

        // A value typed in is judged now, while its writer is looking; one that reads a variable is
        // judged by each run, and a run that finds it wrong says so on the node.
        switch (test)
        {
            case "gt" or "gte" or "lt" or "lte":
                if (valueText.Trim().Length == 0 || value.IsLiteral && PayloadValue.AsReading(value.LiteralText) is null)
                {
                    problem = "Give the number to compare with.";
                    return null;
                }

                return new IfNode(id, field, new CompareTest(test), value, value2);

            case "eq" or "neq":
                return new IfNode(id, field, new EqualsTest(negate: test == "neq"), value, value2);

            case "between":
                if (valueText.Trim().Length == 0 || value2Text.Trim().Length == 0 ||
                    value.IsLiteral && value2.IsLiteral &&
                    (PayloadValue.AsReading(value.LiteralText) is not { } low ||
                     PayloadValue.AsReading(value2.LiteralText) is not { } high || low > high))
                {
                    problem = "Give two numbers, the lower one first.";
                    return null;
                }

                return new IfNode(id, field, new BetweenTest(), value, value2);

            case "matches":
            {
                Regex? compiled = null;

                if (value.IsLiteral)
                {
                    try
                    {
                        compiled = CompiledPatterns.Compile(value.LiteralText);
                    }
                    catch (ArgumentException ex)
                    {
                        problem = $"This pattern does not compile: {ex.Message}";
                        return null;
                    }
                }

                return new IfNode(id, field, new MatchesTest(compiled), value, value2);
            }

            case "oneOf":
                if (value.IsLiteral && !value.LiteralText.Split(',').Any(one => one.Trim().Length > 0))
                {
                    problem = "List at least one value, separated by commas.";
                    return null;
                }

                return new IfNode(id, field, new OneOfTest(), value, value2);

            case "exists":
                return new IfNode(id, field, new ExistsTest(), value, value2);

            default:
                problem = "Pick a test.";
                return null;
        }
    }

    private static AlarmRaiseNode? AlarmRaise(string id, Settings settings, IReadOnlySet<string> declared, out string? problem)
    {
        var name = settings.Text("name").Trim();
        if (name.Length is 0 or > FlowLimits.NameLength)
        {
            problem = $"Name the alarm, in at most {FlowLimits.NameLength} characters.";
            return null;
        }

        var level = Level(settings.Text("level"), out problem);
        if (problem is not null) return null;

        // Capped as a topic is: a reason is rendered for every alarm raised, and what it renders is cut at
        // 200 anyway.
        var reasonText = settings.Text("reason").Trim();
        if (reasonText.Length > FlowLimits.ReasonTemplateLength)
        {
            problem = $"Write the reason in at most {FlowLimits.ReasonTemplateLength} characters; " +
                      $"only the first {FlowLimits.ReasonLength} are shown.";
            return null;
        }

        // A reason left blank says the alarm's own name, which is at least a sentence. It says it as it was
        // typed and never as a template: braces in a name are part of it, and a name read as a template could
        // be refused for a placeholder in a reason nobody wrote, or fill in a topic nobody asked for.
        var reason = reasonText.Length == 0 ? FlowTemplate.Verbatim(name) : Template(reasonText, declared, out problem);
        if (problem is not null) return null;

        var value = Value(settings.Text("value"), declared, out problem);
        return problem is null ? new AlarmRaiseNode(id, name, level, reason, value) : null;
    }

    private static AlertSeverity Level(string text, out string? problem)
    {
        problem = null;

        switch (text)
        {
            case "info": return AlertSeverity.Info;
            case "warn": return AlertSeverity.Warn;
            case "critical": return AlertSeverity.Critical;
            default:
                problem = "Pick a level: info, warn or critical.";
                return AlertSeverity.Info;
        }
    }

    /// <summary>A template, and a problem when it cannot be read or reads a variable the flow does not declare.</summary>
    private static FlowTemplate Template(string text, IReadOnlySet<string> declared, out string? problem)
    {
        var template = FlowTemplate.Parse(text, out problem);

        if (problem is null && template.Variables.FirstOrDefault(name => !declared.Contains(name)) is { } missing)
            problem = NoSuchVariable(missing);

        return template;
    }

    /// <summary>A value, and a problem when it is too long, cannot be read or reads a variable the flow does not declare.</summary>
    // Too long is said of a field's path, since that is all such a box can hold at that length: a variable's
    // name is forty characters at most, and the whole payload is no characters at all.
    private static FlowValue Value(string text, IReadOnlySet<string> declared, out string? problem)
    {
        if (text.Length > FlowLimits.TextTemplateLength)
        {
            problem = $"A field's path is at most {FlowLimits.TextTemplateLength} characters.";
            return FlowValue.Payload;
        }

        var value = FlowValue.Parse(text, out problem);

        if (problem is null && value.Variable is { } name && !declared.Contains(name))
            problem = NoSuchVariable(name);

        return value;
    }

    // A typo is a refusal, not a variable that reads as nothing: "lmit" would otherwise compare every
    // reading with an empty value and say "no" for ever, and nothing would say why.
    private static string NoSuchVariable(string name) => $"There is no variable called {name}. Add it to the flow's variables.";

    /// <summary>The drawing's own rules: one Start, every way out wired once, every node reached, loops the only circles.</summary>
    /// <returns>The Start node's id, or null when there is none.</returns>
    private static string? Structure(
        IReadOnlyDictionary<string, string> types, IReadOnlyList<string> order, IReadOnlyList<FlowEdge> wires,
        IReadOnlyDictionary<string, CompiledNode> nodes, List<FlowProblem> problems)
    {
        var starts = order.Where(id => types[id] == FlowPorts.Start).ToList();

        if (starts.Count == 0)
            problems.Add(new(null, null, "A flow begins at a Start, and this one has none."));

        foreach (var extra in starts.Skip(1))
            problems.Add(new(extra, null, "A flow has one Start; this is a second."));

        // Every way out wired, once. A way out with no wire would leave a run with nowhere to go, and
        // one with two would have it go two ways at once: a flow does one thing at a time.
        foreach (var id in order)
        {
            var outs = FlowPorts.Outs(types[id]);

            foreach (var port in outs)
            {
                var count = wires.Count(wire => wire.From == id && wire.FromPort == port);
                var which = outs.Count == 1 ? "This node's way out" : $"The {port} way out";

                if (count == 0)
                    problems.Add(new(id, null, $"{which} goes nowhere. Wire it on, or to an End."));
                else if (count > 1)
                    problems.Add(new(id, null, $"{which} has {count} wires. A flow does one thing at a time, so it can have one."));
            }
        }

        if (starts.Count == 0) return null;

        var start = starts[0];
        var reached = Reached(start, wires, avoid: null);

        // A second Start is never reached — nothing can be wired into one — and has been told so above.
        foreach (var id in order)
            if (!reached.Contains(id) && types[id] != FlowPorts.Start)
                problems.Add(new(id, null, "Nothing leads here from Start."));

        // The one wire that may go back is a loop body's return into its loop's next. Any other circle
        // has no loop to count its turns, and a run on it would go round for ever.
        var forward = wires.Where(wire => !(wire.ToPort == FlowPorts.Next && FlowPorts.IsLoop(types[wire.To]))).ToList();
        if (GoesRound(order, forward))
            problems.Add(new(null, null,
                "The wires go round in a circle. Loops are drawn with For or For each: wire the last step of the body back to the loop's next."));

        foreach (var loop in order.Where(id => FlowPorts.IsLoop(types[id])))
        {
            var body = Region(wires, loop, "body");
            var after = Region(wires, loop, "done");
            var outside = Reached(start, wires, avoid: loop);
            var returns = wires.Where(wire => wire.To == loop && wire.ToPort == FlowPorts.Next).ToList();
            var lastSteps = new List<string>();

            if (returns.Count == 0)
                problems.Add(new(loop, null, "Nothing comes back to this loop. Wire the last step of its body to its next."));

            // A turn ends when the run comes back to next, so only a node a turn can be at may wire
            // there: one in the body, that nothing before the loop and nothing after it also reaches.
            // Anything else would arrive at next with no turn going.
            foreach (var wire in returns)
            {
                var own = wire.From == loop && wire.FromPort == "body" ||
                          body.Contains(wire.From) && !after.Contains(wire.From) && !outside.Contains(wire.From);

                if (own) lastSteps.Add(wire.From);
                else problems.Add(new(null, wire.Id, "Only the loop's own body comes back to its next."));
            }

            // A forever loop that never waits would go round as fast as the server can, so a turn of it
            // has to hold something that waits: a Wait, or an MQTT in reading the next message. A turn,
            // and not everything the body leads to: that takes in wherever a break goes as well — an End,
            // what done leads to, the next turn of a loop around this one — and a Wait out there is one
            // the run reaches only once it has left the turn.
            //
            // Only a loop its own body comes back to has a turn to look in. One that nothing comes back to
            // has been told so, and one whose returns are all refused has been told of each of them; told
            // to wait as well, its writer would go looking for a Wait to add when the one the body holds
            // is simply on its way somewhere else.
            if (lastSteps.Count > 0 && nodes.GetValueOrDefault(loop) is ForNode { Forever: true } &&
                !Turn(wires, body, lastSteps).Any(id => types[id] is FlowPorts.Wait or FlowPorts.MqttIn))
                problems.Add(new(loop, null,
                    "A forever loop must wait. Put a Wait or an MQTT in in its body, on the way back to its next."));
        }

        return start;
    }

    /// <summary>Every node a run from <paramref name="from"/> could reach, without going on through <paramref name="avoid"/>.</summary>
    private static HashSet<string> Reached(string from, IReadOnlyList<FlowEdge> wires, string? avoid)
    {
        var reached = new HashSet<string>(StringComparer.Ordinal) { from };
        var queue = new Queue<string>([from]);

        while (queue.TryDequeue(out var id))
        {
            if (id == avoid) continue;

            foreach (var wire in wires)
                if (wire.From == id && reached.Add(wire.To))
                    queue.Enqueue(wire.To);
        }

        return reached;
    }

    /// <summary>What one of a loop's ways out leads to, without passing through the loop again.</summary>
    private static HashSet<string> Region(IReadOnlyList<FlowEdge> wires, string loop, string port)
    {
        var region = new HashSet<string>(StringComparer.Ordinal);
        var queue = new Queue<string>();

        foreach (var wire in wires)
            if (wire.From == loop && wire.FromPort == port && wire.To != loop && region.Add(wire.To))
                queue.Enqueue(wire.To);

        while (queue.TryDequeue(out var id))
            foreach (var wire in wires)
                if (wire.From == id && wire.To != loop && region.Add(wire.To))
                    queue.Enqueue(wire.To);

        return region;
    }

    /// <summary>The nodes of a loop's body that a turn goes through: those from which one of its last steps can still be reached.</summary>
    // A last step is a node whose wire back to the loop's next is the loop's own; an empty body's is the
    // loop itself, which is no node of its body. Walked backwards from them, through the body alone. A loop
    // held in the turn brings in the part of its own body that leads back to it, since that part leads on,
    // through it, to the loop it is in; a step of its body that only breaks out — to an End, or past both
    // loops — leads back to neither, and is no more in the turn than a step of this loop's own body that
    // breaks out would be.
    private static HashSet<string> Turn(IReadOnlyList<FlowEdge> wires, IReadOnlySet<string> body, IEnumerable<string> lastSteps)
    {
        var turn = new HashSet<string>(lastSteps.Where(body.Contains), StringComparer.Ordinal);
        var queue = new Queue<string>(turn);

        while (queue.TryDequeue(out var id))
            foreach (var wire in wires)
                if (wire.To == id && body.Contains(wire.From) && turn.Add(wire.From))
                    queue.Enqueue(wire.From);

        return turn;
    }

    private static string? Wire(
        FlowEdge edge, IReadOnlyDictionary<string, string> types, ISet<string> ids,
        ISet<(string, string, string, string)> joined)
    {
        if (!IdPattern.IsMatch(edge.Id) || !ids.Add(edge.Id))
            return "A wire needs its own id.";

        if (!types.TryGetValue(edge.From, out var from) || !types.TryGetValue(edge.To, out var to))
            return "This wire does not start and end on nodes.";

        // A loop with nothing in its body yet is the one node wired to itself — its body straight back
        // to its next — which is how a new loop is drawn.
        var emptyBody = FlowPorts.IsLoop(from) && edge.FromPort == "body" && edge.ToPort == FlowPorts.Next;
        if (edge.From == edge.To && !emptyBody)
            return "A wire cannot come back to its own node.";

        if (!FlowPorts.Outs(from).Contains(edge.FromPort))
            return $"This node has no way out called '{edge.FromPort}'.";

        if (!FlowPorts.Ins(to).Contains(edge.ToPort))
            return $"That node has no way in called '{edge.ToPort}'.";

        if (!joined.Add((edge.From, edge.FromPort, edge.To, edge.ToPort)))
            return "Two wires join the same ports.";

        return null;
    }

    // Kahn's algorithm: whatever is left once every node with no way in has been taken away is a
    // circle. Only wires that passed Wire, and no loop's return, are counted.
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
        // Each node's settings are written out afresh and not taken as the text they came in: flows.json is
        // indented and escapes what a PUT body sends compact and as typed, and one flow read from either has
        // to come out as one flow. The settings keep their order, which is what was written.
        var shape = JsonSerializer.Serialize(new
        {
            flow.Name,
            Nodes = flow.Nodes.Select(node => new
            {
                node.Id,
                node.Type,
                Config = node.Config.ValueKind == JsonValueKind.Undefined ? "{}" : JsonSerializer.Serialize(node.Config),
            }),
            flow.Edges,
            flow.Variables,
        }, FlowJson.Options);

        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(shape)));
    }

    // One limit for every payload a flow holds — what a Publish sends and what a Webhook posts — said in the
    // word its pane uses for the box: a Publish has a payload and a Webhook a body.
    private static string? PayloadProblem(string payload, string what) =>
        Encoding.UTF8.GetByteCount(payload) > FlowLimits.PayloadBytes ? $"{what} is at most 64 KB." : null;

    // \z where the rule is written with $: in .NET a $ also matches in front of a final line break,
    // so "n1\n" would pass as an id that is safe in a topic, a rule id and a file, and is none of them.
    [GeneratedRegex("^[A-Za-z0-9_-]{1,40}\\z", RegexOptions.CultureInvariant)]
    private static partial Regex IdRegex();

    /// <summary>A node's settings, read leniently: a wrong type is the same as a missing value.</summary>
    // Lenient because the editor writes numbers from text boxes, and a number that arrives as "0.5" is
    // the number 0.5 to anyone who typed it.
    //
    // Made only by TryRead, and so only of settings in which every name and every string can be read as
    // text. That is why a string is read below with GetString and a name looked up with TryGetProperty,
    // with nothing between them and the answer: both throw on an escaped half of a surrogate pair, which
    // is valid JSON and no text, and a PUT body or a flows.json somebody edited can hold one. A node that
    // does is refused by the caller, on itself, and never gets as far as being read.
    private readonly struct Settings
    {
        private readonly JsonElement _config;

        private Settings(JsonElement config) => _config = config;

        /// <summary>The settings in <paramref name="config"/>, or false when they hold text that cannot be read.</summary>
        public static bool TryRead(JsonElement config, out Settings settings)
        {
            var reads = PayloadValue.ReadsAsText(config);

            settings = new Settings(reads ? config : default);
            return reads;
        }

        private JsonElement? Get(string name) =>
            _config.ValueKind == JsonValueKind.Object && _config.TryGetProperty(name, out var value) ? value : null;

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
