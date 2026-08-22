using MqttForge.Domain.Enums;

namespace MqttForge.Domain.Models;

// What it takes to reach a broker. The first six are the ones every connection has; the rest
// are defaulted so that settings written before they existed still deserialise into the
// behaviour they used to get, and so that constructing one in a test stays a single line.
//
// UseTls is kept as its own flag rather than folded into Transport because it is the question
// every other part of the app already asks — the saved settings, a failure, a live link all
// carry it — and the four schemes a reader picks from are exactly these two crossed.
public record BrokerConnectionSettings(
    string Host,
    int Port,
    string ClientId,
    string? Username,
    string? Password,
    bool UseTls,
    MqttTransport Transport = MqttTransport.Tcp,

    // Auto by default: the console's job is to connect to the broker in front of it, and asking
    // a reader to know which MQTT their broker speaks before it will talk to them is asking the
    // wrong person. A fixed version is still selectable, for testing a broker's behaviour on one.
    MqttProtocolLevel ProtocolVersion = MqttProtocolLevel.Auto,

    // Where the WebSocket endpoint lives on the host. Ignored on TCP.
    string? WebSocketPath = null,

    // Start with no state from a previous session, and keep none after this one. True is both
    // MQTT's own default and the only sane default for a console: a test tool that quietly
    // resumed a subscription set from an hour ago would fill the tree with topics nobody asked
    // for. Called Clean Start on 5.0 and Clean Session on 3.x; it is the same bit on the wire.
    bool CleanSession = true,

    // Seconds the broker should keep this session after we go away. MQTT 5 only — 3.x has no
    // such field, and the state either dies with a clean session or lives forever without one.
    // Null means "say nothing", which the broker reads as zero.
    uint? SessionExpiryInterval = null,

    BrokerTlsSettings? Tls = null)
{
    // Never null at the point of use, so nothing downstream has to check.
    public BrokerTlsSettings TlsSettings => Tls ?? BrokerTlsSettings.None;

    // The path a WebSocket connection actually uses. Nearly every broker publishes /mqtt and a
    // reader who leaves the box empty means that one, not the site root — which is where a
    // reverse proxy answers with a web page and the console reports a broker that isn't there.
    public const string DefaultWebSocketPath = "/mqtt";

    // Where this connection goes, in the form people write it down in. Used for anything that
    // has to name the endpoint as one string — a log line, the address under the rail.
    public string Endpoint => Transport == MqttTransport.WebSocket
        ? $"{Scheme}://{Host}:{Port}{NormalisedWebSocketPath}"
        : $"{Scheme}://{Host}:{Port}";

    public string Scheme => (Transport, UseTls) switch
    {
        (MqttTransport.WebSocket, true) => "wss",
        (MqttTransport.WebSocket, false) => "ws",
        (_, true) => "mqtts",
        _ => "mqtt"
    };

    public string NormalisedWebSocketPath
    {
        get
        {
            var path = WebSocketPath?.Trim();
            if (string.IsNullOrEmpty(path)) return DefaultWebSocketPath;

            return path.StartsWith('/') ? path : "/" + path;
        }
    }
}
