namespace MqttForge.Application.Flows;

/// <summary>The node types of a flowchart, and the ports each one has.</summary>
// One table, read by the compiler to check every wire and mirrored by the editor's node registry
// (web/src/features/flows/nodeTypes.ts) to draw the handles. A port in one and not the other is a
// wire the canvas lets somebody draw and the server refuses.
//
// Every step has one way in and one way out. Start has only a way out and End only a way in; a
// decision has two ways out; a loop has two ways in — "in" to start it, "next" for its body to come
// back to — and two ways out, "body" for each turn and "done" after the last.
public static class FlowPorts
{
    public const string Start = "start";
    public const string End = "end";
    public const string MqttIn = "mqttIn";
    public const string If = "if";
    public const string For = "for";
    public const string ForEach = "forEach";
    public const string Wait = "wait";
    public const string Set = "set";
    public const string Publish = "publish";
    public const string Debug = "debug";
    public const string AlarmRaise = "alarmRaise";
    public const string AlarmClear = "alarmClear";
    public const string Sound = "sound";
    public const string Notify = "notify";
    public const string Webhook = "webhook";

    /// <summary>A loop's way back in: where the last step of its body is wired.</summary>
    public const string Next = "next";

    public static bool Known(string type) =>
        type is Start or End or MqttIn or If or For or ForEach or Wait or Set or Publish or Debug
            or AlarmRaise or AlarmClear or Sound or Notify or Webhook;

    public static bool IsLoop(string type) => type is For or ForEach;

    public static IReadOnlyList<string> Ins(string type) => type switch
    {
        For or ForEach => ["in", Next],
        End or MqttIn or If or Wait or Set or Publish or Debug or AlarmRaise or AlarmClear or Sound or Notify or Webhook => ["in"],
        _ => [],
    };

    public static IReadOnlyList<string> Outs(string type) => type switch
    {
        If => ["yes", "no"],
        For or ForEach => ["body", "done"],
        AlarmRaise => ["raised", "up"],
        AlarmClear => ["cleared", "none"],
        Start or MqttIn or Wait or Set or Publish or Debug or Sound or Notify or Webhook => ["out"],
        _ => [],
    };
}
