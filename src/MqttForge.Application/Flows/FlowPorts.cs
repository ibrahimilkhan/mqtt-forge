namespace MqttForge.Application.Flows;

/// <summary>The node types, and the ports each one has.</summary>
// One table, read by the compiler to check every wire and mirrored by the editor's node registry
// (web/src/features/flows/nodeTypes.ts) to draw the handles. A port that existed in one and not
// the other would be a wire the canvas lets somebody draw and the server refuses.
public static class FlowPorts
{
    public const string MqttIn = "mqttIn";
    public const string Every = "every";
    public const string Inject = "inject";
    public const string If = "if";
    public const string ForEach = "forEach";
    public const string Repeat = "repeat";
    public const string Alarm = "alarm";
    public const string Publish = "publish";
    public const string Debug = "debug";

    public static bool Known(string type) =>
        type is MqttIn or Every or Inject or If or ForEach or Repeat or Alarm or Publish or Debug;

    public static IReadOnlyList<string> Ins(string type) => type switch
    {
        If or ForEach or Repeat or Publish or Debug => ["in"],
        // Two inputs rather than one input and a setting: "if the boiler is hot, raise; if it is
        // not, clear" is then drawn exactly as it is said, with the If's two branches running to
        // the alarm's two sides.
        Alarm => ["raise", "clear"],
        _ => [],
    };

    public static IReadOnlyList<string> Outs(string type) => type switch
    {
        MqttIn or Every or Inject or ForEach or Repeat => ["out"],
        If => ["yes", "no"],
        _ => [],
    };
}
