using System.Text.Json;
using System.Text.Json.Serialization;

namespace MqttForge.Application.Alerts;

/// <summary>How an alert rule is written, on disk and on the wire alike.</summary>
// One holder rather than two, and it lives in Application rather than beside WireJson, because
// the store that writes the file is in Infrastructure and Infrastructure does not reference Api.
// The shape is a contract shared by three readers — the file, the PUT body, and
// web/src/types/api.ts — and a second set of options anywhere would let them drift apart while
// every test stayed green.
//
// camelCase, unlike colour-rules.json, which passes no options at all and so writes its
// properties PascalCase. That file is a preference nobody reads; this one is a record someone
// edits by hand and a shape the browser types mirror.
public static class AlertRuleJson
{
    public static JsonSerializerOptions Options { get; } = Build();

    /// <summary>The same shape, indented, for the file a person opens in an editor.</summary>
    public static JsonSerializerOptions File { get; } = new(Build()) { WriteIndented = true };

    private static JsonSerializerOptions Build()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
        return options;
    }
}
