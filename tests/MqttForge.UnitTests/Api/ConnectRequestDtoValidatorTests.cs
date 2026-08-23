using MqttForge.Api.Contracts;
using MqttForge.Api.Validation;
using MqttForge.Domain.Enums;
using Xunit;

namespace MqttForge.UnitTests.Api;

// What the API refuses before a broker is dialled at all. The bar is deliberately low: a broker
// gives a better answer about its own configuration than any guess made from this side, so only
// the things that would never reach one are stopped here.
public class ConnectRequestDtoValidatorTests
{
    private readonly ConnectRequestDtoValidator _validator = new();

    private static ConnectRequestDto Request(string clientId = "console") =>
        new("broker.local", 1883, clientId, null, null, false);

    private static ConnectRequestDto OverWebSocket(string? path) =>
        Request() with { Transport = MqttTransport.WebSocket, WebSocketPath = path };

    [Fact]
    public void The_plainest_possible_request_is_accepted()
    {
        Assert.True(_validator.Validate(Request()).IsValid);
    }

    [Theory]
    [InlineData("/mqtt")]
    [InlineData("mqtt")]
    [InlineData("/a/deeper/path")]
    [InlineData("/mqtt-v5")]
    [InlineData("/ws?token=abc")]
    [InlineData(null)]
    [InlineData("")]
    public void A_path_a_broker_could_answer_is_left_alone(string? path)
    {
        Assert.True(_validator.Validate(OverWebSocket(path)).IsValid);
    }

    // Nothing is refused, including the paths that look malformed. A rule here once asked
    // Uri.TryCreate whether they could be dialled, on the theory that a space would never reach
    // a broker; Uri accepts and escapes both, so the rule refused nothing. What happens instead
    // is the request going out escaped, the broker answering 404, and the console saying the
    // upgrade was refused and that the path is usually why — which is the better answer.
    [Theory]
    [InlineData("/has a space")]
    [InlineData("/back\\slash")]
    [InlineData("/almost/certainly/wrong")]
    public void A_path_that_looks_wrong_is_still_the_broker_s_answer_to_give(string path)
    {
        Assert.True(_validator.Validate(OverWebSocket(path)).IsValid);
    }

    // MQTT 3.x has no field for it, and MQTTnet refuses to build options carrying one. Saying so
    // beats a 500 from somewhere inside the client library.
    [Theory]
    [InlineData(MqttProtocolLevel.V310)]
    [InlineData(MqttProtocolLevel.V311)]
    public void Session_expiry_is_refused_on_a_version_that_has_nowhere_to_put_it(
        MqttProtocolLevel version)
    {
        var result = _validator.Validate(
            Request() with { ProtocolVersion = version, SessionExpiryInterval = 600 });

        Assert.False(result.IsValid);
        Assert.Contains("MQTT 5", result.Errors[0].ErrorMessage);
    }

    // Auto tries 5.0 first and gets it from nearly every broker in service, so the field applies
    // and is allowed; the ladder drops it on any rung that cannot carry it.
    [Theory]
    [InlineData(MqttProtocolLevel.Auto)]
    [InlineData(MqttProtocolLevel.V500)]
    public void Session_expiry_is_allowed_wherever_it_could_apply(MqttProtocolLevel version)
    {
        Assert.True(_validator
            .Validate(Request() with { ProtocolVersion = version, SessionExpiryInterval = 600 })
            .IsValid);
    }

    // Both ends of the range mean something in MQTT 5 — no session, and one that never expires.
    [Theory]
    [InlineData(0u)]
    [InlineData(uint.MaxValue)]
    public void Every_expiry_MQTT_5_defines_is_accepted(uint seconds)
    {
        Assert.True(_validator
            .Validate(Request() with { SessionExpiryInterval = seconds })
            .IsValid);
    }

    // MQTT 3.1 caps a client id at 23 characters, and the console warns about it. The API does
    // not refuse it: brokers vary on whether they enforce the cap, and a broker that would have
    // accepted this is one the reader could no longer test.
    [Fact]
    public void A_client_id_too_long_for_3_1_is_left_to_the_broker()
    {
        var result = _validator.Validate(
            Request("a-client-id-of-well-over-twenty-three-characters") with
            {
                ProtocolVersion = MqttProtocolLevel.V310,
            });

        Assert.True(result.IsValid);
    }

    [Fact]
    public void An_empty_host_is_refused()
    {
        Assert.False(_validator.Validate(Request() with { Host = "" }).IsValid);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(65536)]
    [InlineData(-1)]
    public void A_port_that_is_not_one_is_refused(int port)
    {
        Assert.False(_validator.Validate(Request() with { Port = port }).IsValid);
    }
}
