using System.Text.Json;
using System.Text.Json.Serialization;

namespace MqttForge.Api.Contracts;

// How enums are written on the wire, in one place because there are three wires. The console
// reads the connection state over REST and over the hub, and a transport that arrived as
// "webSocket" from one and as 1 from the other would be a bug nobody could see until a link
// dropped and the panel disagreed with itself.
public static class WireJson
{
    // Names, not numbers: a reason, a transport and a version all mean something to a reader
    // looking at the network tab, and a number renumbers itself the day someone reorders an enum.
    public static JsonStringEnumConverter EnumsAsNames() => new(JsonNamingPolicy.CamelCase);

    public static void Apply(JsonSerializerOptions options) =>
        options.Converters.Add(EnumsAsNames());

    /// <summary>What a .NET client needs to read this API's JSON back into these types.</summary>
    // Public because the contract is: camelCase properties, enums as camelCase names. Anything
    // deserialising a BrokerLinkDto with stock options fails on the first enum it meets, and
    // discovering that from a stack trace is worse than being handed the answer.
    public static JsonSerializerOptions Client { get; } = Build();

    private static JsonSerializerOptions Build()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        Apply(options);
        return options;
    }
}
