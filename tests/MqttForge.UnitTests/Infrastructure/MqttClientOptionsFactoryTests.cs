using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Mqtt;
using MQTTnet;
using MQTTnet.Formatter;
using Xunit;

namespace MqttForge.UnitTests.Infrastructure;

// The mapping from settings to MQTTnet options. Testable without a broker, and worth testing
// without one: the rules here are about which of four schemes a URI gets and what a blank field
// means, and a broker would only tell us whether the answer happened to work today.
public class MqttClientOptionsFactoryTests
{
    private static BrokerConnectionSettings Settings(
        MqttTransport transport = MqttTransport.Tcp, bool useTls = false, string? path = null) =>
        new("broker.local", 1883, "console", null, null, useTls, transport, MqttProtocolLevel.Auto, path);

    private static readonly TlsCertificateInspector Inspector = new();

    // Auto is an instruction, not a version, and this is where it turns into one.
    [Fact]
    public void Auto_expands_to_every_version_newest_first()
    {
        Assert.Equal(
            [MqttProtocolLevel.V500, MqttProtocolLevel.V311, MqttProtocolLevel.V310],
            MqttClientOptionsFactory.VersionsToTry(MqttProtocolLevel.Auto));
    }

    [Theory]
    [InlineData(MqttProtocolLevel.V500)]
    [InlineData(MqttProtocolLevel.V311)]
    [InlineData(MqttProtocolLevel.V310)]
    public void A_version_asked_for_by_name_is_tried_once_and_alone(MqttProtocolLevel version)
    {
        Assert.Equal([version], MqttClientOptionsFactory.VersionsToTry(version));
    }

    [Theory]
    [InlineData(MqttProtocolLevel.V310, MqttProtocolVersion.V310)]
    [InlineData(MqttProtocolLevel.V311, MqttProtocolVersion.V311)]
    [InlineData(MqttProtocolLevel.V500, MqttProtocolVersion.V500)]
    public void Each_version_reaches_the_wire_as_itself(MqttProtocolLevel level, MqttProtocolVersion wire)
    {
        Assert.Equal(wire, MqttClientOptionsFactory.Build(Settings(), level, Inspector).ProtocolVersion);
    }

    // Answering with a guess would hide the caller that forgot to expand it.
    [Fact]
    public void Auto_is_refused_where_a_version_is_required()
    {
        Assert.Throws<ArgumentOutOfRangeException>(
            () => MqttClientOptionsFactory.Wire(MqttProtocolLevel.Auto));
    }

    // MQTTnet reads the scheme off this URI to decide whether to wrap the socket in TLS, so the
    // scheme — not the TLS options — is what actually turns encryption on for a WebSocket.
    [Theory]
    [InlineData(false, "ws://broker.local:1883/mqtt")]
    [InlineData(true, "wss://broker.local:1883/mqtt")]
    public void A_WebSocket_is_dialled_at_the_scheme_its_encryption_calls_for(bool useTls, string expected)
    {
        Assert.Equal(
            expected,
            MqttClientOptionsFactory.WebSocketUri(Settings(MqttTransport.WebSocket, useTls)));
    }

    // A reader who leaves the box empty means /mqtt, not the site root — which is where a
    // reverse proxy answers with a web page and the console reports a broker that isn't there.
    [Theory]
    [InlineData(null, "/mqtt")]
    [InlineData("", "/mqtt")]
    [InlineData("   ", "/mqtt")]
    [InlineData("mqtt", "/mqtt")]
    [InlineData("/paho", "/paho")]
    [InlineData("/a/deeper/path", "/a/deeper/path")]
    public void A_path_is_read_the_way_it_was_meant(string? written, string expected)
    {
        Assert.Equal(expected, Settings(MqttTransport.WebSocket, path: written).NormalisedWebSocketPath);
    }

    [Theory]
    [InlineData(MqttTransport.Tcp, false, "mqtt://broker.local:1883")]
    [InlineData(MqttTransport.Tcp, true, "mqtts://broker.local:1883")]
    [InlineData(MqttTransport.WebSocket, false, "ws://broker.local:1883/mqtt")]
    [InlineData(MqttTransport.WebSocket, true, "wss://broker.local:1883/mqtt")]
    public void An_endpoint_reads_as_people_write_it_down(
        MqttTransport transport, bool useTls, string expected)
    {
        Assert.Equal(expected, Settings(transport, useTls).Endpoint);
    }

    // MQTT 3.x has nowhere to put this, and MQTTnet's own validation refuses to build options
    // carrying one — rightly, since the packet has no field for it.
    [Fact]
    public void Session_expiry_is_sent_only_on_the_version_that_has_the_field()
    {
        var settings = Settings() with { SessionExpiryInterval = 600 };

        Assert.Equal(
            600u,
            MqttClientOptionsFactory.Build(settings, MqttProtocolLevel.V500, Inspector).SessionExpiryInterval);
        Assert.Equal(
            0u,
            MqttClientOptionsFactory.Build(settings, MqttProtocolLevel.V311, Inspector).SessionExpiryInterval);
    }

    // The same bit on the wire under both of its names.
    [Fact]
    public void A_kept_session_is_asked_for_on_every_version()
    {
        var settings = Settings() with { CleanSession = false };

        Assert.False(MqttClientOptionsFactory.Build(settings, MqttProtocolLevel.V500, Inspector).CleanSession);
        Assert.False(MqttClientOptionsFactory.Build(settings, MqttProtocolLevel.V311, Inspector).CleanSession);
    }

    [Fact]
    public void A_TCP_connection_is_built_on_a_TCP_channel()
    {
        var options = MqttClientOptionsFactory.Build(Settings(), MqttProtocolLevel.V500, Inspector);

        Assert.IsType<MqttClientTcpOptions>(options.ChannelOptions);
    }

    [Fact]
    public void A_WebSocket_connection_is_built_on_a_WebSocket_channel()
    {
        var options = MqttClientOptionsFactory.Build(
            Settings(MqttTransport.WebSocket), MqttProtocolLevel.V500, Inspector);

        var channel = Assert.IsType<MqttClientWebSocketOptions>(options.ChannelOptions);
        Assert.Equal("ws://broker.local:1883/mqtt", channel.Uri);
    }

    // Whichever channel it is, the TLS options have to land on it — a connection configured for
    // encryption that quietly is not is the worst shape a bug about encryption can take.
    [Theory]
    [InlineData(MqttTransport.Tcp)]
    [InlineData(MqttTransport.WebSocket)]
    public void Encryption_reaches_the_channel_it_was_asked_for_on(MqttTransport transport)
    {
        var options = MqttClientOptionsFactory.Build(
            Settings(transport, useTls: true), MqttProtocolLevel.V500, Inspector);

        Assert.True(Tls(options).UseTls);
    }

    [Fact]
    public void Nothing_is_encrypted_that_was_not_asked_to_be()
    {
        Assert.False(Tls(MqttClientOptionsFactory.Build(Settings(), MqttProtocolLevel.V500, Inspector)).UseTls);
    }

    // The one setting that turns verification off. Both flags, because MQTTnet consults them in
    // different places and half of it is worse than neither.
    [Fact]
    public void Accepting_any_certificate_says_so_in_both_places_MQTTnet_reads()
    {
        var settings = Settings(useTls: true) with
        {
            Tls = new BrokerTlsSettings(AllowUntrustedCertificates: true),
        };

        var tls = Tls(MqttClientOptionsFactory.Build(settings, MqttProtocolLevel.V500, Inspector));

        Assert.True(tls.AllowUntrustedCertificates);
        Assert.True(tls.IgnoreCertificateChainErrors);
    }

    [Fact]
    public void Verification_stays_on_when_nobody_turned_it_off()
    {
        var tls = Tls(MqttClientOptionsFactory.Build(Settings(useTls: true), MqttProtocolLevel.V500, Inspector));

        Assert.False(tls.AllowUntrustedCertificates);
        Assert.False(tls.IgnoreCertificateChainErrors);
    }

    // AWS IoT Core takes MQTT on 443 only when this is negotiated, which is the only way
    // through a firewall that allows nothing else.
    [Fact]
    public void An_application_protocol_is_offered_when_one_is_named()
    {
        var settings = Settings(useTls: true) with
        {
            Tls = new BrokerTlsSettings(AlpnProtocol: "x-amzn-mqtt-ca"),
        };

        var tls = Tls(MqttClientOptionsFactory.Build(settings, MqttProtocolLevel.V500, Inspector));

        Assert.Equal("x-amzn-mqtt-ca", Assert.Single(tls.ApplicationProtocols).ToString());
    }

    // For a broker behind a load balancer, or anything routed by name rather than by address.
    [Fact]
    public void The_name_offered_in_the_handshake_can_be_told_apart_from_the_host_dialled()
    {
        var settings = Settings(useTls: true) with
        {
            Tls = new BrokerTlsSettings(SniHost: "real.broker.example"),
        };

        var tls = Tls(MqttClientOptionsFactory.Build(settings, MqttProtocolLevel.V500, Inspector));

        Assert.Equal("real.broker.example", tls.TargetHost);
    }

    private static MqttClientTlsOptions Tls(MqttClientOptions options) => options.ChannelOptions switch
    {
        MqttClientTcpOptions tcp => tcp.TlsOptions,
        MqttClientWebSocketOptions ws => ws.TlsOptions,
        _ => throw new InvalidOperationException("unknown channel"),
    };
}
