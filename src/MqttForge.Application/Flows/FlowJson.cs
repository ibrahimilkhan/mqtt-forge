using System.Text.Json;

namespace MqttForge.Application.Flows;

/// <summary>How a flow is written, in flows.json and on the wire alike.</summary>
// In Application, beside AlertRuleJson and for its reason: the store that writes the file is in
// Infrastructure, which does not reference Api, and the file, the PUT body and
// web/src/types/api.ts are one contract that a second set of options would let drift apart.
public static class FlowJson
{
    public static JsonSerializerOptions Options { get; } = new(JsonSerializerDefaults.Web);

    /// <summary>The same shape, indented, for the file a person opens in an editor.</summary>
    public static JsonSerializerOptions File { get; } = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    /// <summary>A node's settings when it has none — Debug's, and any node written without them.</summary>
    // A default JsonElement is 'Undefined', and serialising one throws. Every path that could hand
    // one on — the store reading a hand-written node, the DTO mapping a body without 'config' —
    // swaps it for this instead.
    public static JsonElement EmptyConfig { get; } = JsonDocument.Parse("{}").RootElement.Clone();

    /// <summary>The settings as given, or empty settings when none were.</summary>
    public static JsonElement OrEmpty(JsonElement config) =>
        config.ValueKind == JsonValueKind.Object ? config : EmptyConfig;
}
