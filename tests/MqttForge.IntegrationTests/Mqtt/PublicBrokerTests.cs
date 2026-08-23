using System.Net.Http.Json;
using MqttForge.Api.Contracts;
using MqttForge.Domain.Enums;
using MqttForge.IntegrationTests.Support;
using Xunit;
using Xunit.Abstractions;

namespace MqttForge.IntegrationTests.Mqtt;

/// <summary>
/// Brokers out on the internet, run by other people, reached over all four transports.
/// </summary>
// Skipped unless MQTTFORGE_LIVE=1 — see LiveBrokerFactAttribute for why a free public broker
// having a bad afternoon must not be able to fail a build.
//
// What these are for is the one thing the container suite cannot cover: a certificate signed by
// a real CA and validated against this machine's own store, a WebSocket through somebody else's
// load balancer, and a broker configured by someone who has never seen this code. The three
// here were picked because they are open to anyone and answer on every transport; a cloud
// service with an account behind it is the same shape with credentials, which is what the
// console's cloud presets carry.
public class PublicBrokerTests : IClassFixture<MqttForgeApiFactory>
{
    private readonly MqttForgeApiFactory _factory;
    private readonly ITestOutputHelper _output;

    public PublicBrokerTests(MqttForgeApiFactory factory, ITestOutputHelper output)
    {
        _factory = factory;
        _output = output;
    }

    public static TheoryData<string, string, int, MqttTransport, bool, string?> Endpoints => new()
    {
        // name                 host                  port  transport                tls    path
        { "HiveMQ mqtt",     "broker.hivemq.com",     1883, MqttTransport.Tcp,       false, null },
        { "HiveMQ mqtts",    "broker.hivemq.com",     8883, MqttTransport.Tcp,       true,  null },
        { "HiveMQ ws",       "broker.hivemq.com",     8000, MqttTransport.WebSocket, false, "/mqtt" },
        { "HiveMQ wss",      "broker.hivemq.com",     8884, MqttTransport.WebSocket, true,  "/mqtt" },
        { "EMQX mqtt",       "broker.emqx.io",        1883, MqttTransport.Tcp,       false, null },
        { "EMQX mqtts",      "broker.emqx.io",        8883, MqttTransport.Tcp,       true,  null },
        { "EMQX ws",         "broker.emqx.io",        8083, MqttTransport.WebSocket, false, "/mqtt" },
        { "EMQX wss",        "broker.emqx.io",        8084, MqttTransport.WebSocket, true,  "/mqtt" },
        // Helsinki transit's open feed. TLS only, and the console's own preset points at it.
        { "HSL mqtts",       "mqtt.hsl.fi",           8883, MqttTransport.Tcp,       true,  null },
    };

    [LiveBrokerTheory]
    [MemberData(nameof(Endpoints))]
    public async Task Every_transport_reaches_a_broker_nobody_here_runs(
        string name, string host, int port, MqttTransport transport, bool useTls, string? path)
    {
        var link = await Connect(new ConnectRequestDto(
            host, port, ClientId(name), null, null, useTls, transport,
            MqttProtocolLevel.Auto, path));

        _output.WriteLine($"{name}: speaking {link.ProtocolVersion} over {link.Transport}");

        Assert.Equal(transport, link.Transport);
        Assert.Equal(useTls, link.UseTls);
    }

    // The certificates these serve are signed by real CAs, so strict validation — the default,
    // and the setting nothing in the panel needs touching for a cloud broker — has to accept
    // them with no CA file, no exception and nothing ticked.
    [LiveBrokerTheory]
    [InlineData("broker.hivemq.com", 8883)]
    [InlineData("broker.emqx.io", 8883)]
    [InlineData("mqtt.hsl.fi", 8883)]
    public async Task A_publicly_trusted_certificate_needs_nothing_configured(string host, int port)
    {
        var link = await Connect(new ConnectRequestDto(
            host, port, ClientId($"trust-{host}"), null, null, UseTls: true));

        Assert.True(link.UseTls);
    }

    // Auto against brokers this console has never met. What comes back is what they agreed to.
    [LiveBrokerTheory]
    [InlineData("broker.hivemq.com")]
    [InlineData("broker.emqx.io")]
    public async Task Auto_settles_on_a_version_the_broker_names(string host)
    {
        var link = await Connect(new ConnectRequestDto(
            host, 1883, ClientId($"auto-{host}"), null, null, false));

        _output.WriteLine($"{host} settled on {link.ProtocolVersion}");
        Assert.NotEqual(MqttProtocolLevel.Auto, link.ProtocolVersion);
    }

    // Every version, against a broker configured by somebody else.
    [LiveBrokerTheory]
    [InlineData(MqttProtocolLevel.V500)]
    [InlineData(MqttProtocolLevel.V311)]
    [InlineData(MqttProtocolLevel.V310)]
    public async Task Each_version_is_spoken_to_a_broker_out_on_the_internet(MqttProtocolLevel version)
    {
        var link = await Connect(new ConnectRequestDto(
            "broker.hivemq.com", 1883, ClientId($"v{version}"), null, null, false,
            MqttTransport.Tcp, version));

        Assert.Equal(version, link.ProtocolVersion);
    }

    // Every one of these refuses a client id somebody else is already using, so no two runs —
    // and no two tests inside a run — may share one. Trimmed to 40 characters because some
    // brokers cap the length and answer a long one by refusing the identity rather than the id.
    private static string ClientId(string what)
    {
        var id = $"mqf-{what.Replace(' ', '-')}-{Guid.NewGuid():N}";

        return id.Length <= 40 ? id : id[..40];
    }

    private async Task<BrokerLinkDto> Connect(ConnectRequestDto dto)
    {
        var client = _factory.CreateClient();
        var response = await client.PostAsJsonAsync("/api/connection", dto);
        Assert.True(
            response.IsSuccessStatusCode,
            $"connect to {dto.Host}:{dto.Port} failed: {await response.Content.ReadAsStringAsync()}");

        var state = await client.GetFromJsonAsync<StateResponse>("/api/connection", WireJson.Client);

        return state!.Connection!;
    }

    private sealed record StateResponse(string State, BrokerLinkDto? Connection);
}
