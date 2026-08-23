using System.Text;
using DotNet.Testcontainers.Builders;
using DotNet.Testcontainers.Containers;
using Xunit;

namespace MqttForge.IntegrationTests.Support;

// One Mosquitto wearing every listener MQTTForge can dial: plain, TLS, mutual TLS, and
// WebSockets both ways. One container rather than four, because starting them is the slow part
// of these tests and the listeners do not interfere with each other.
//
// Its certificates are generated per run — see TestCertificates — so nothing here depends on a
// file in the repository, and the CA the console has to be handed is one nothing else trusts.
public sealed class TransportMosquittoFixture : IAsyncLifetime
{
    private const string Config = """
        per_listener_settings true

        listener 1883
        protocol mqtt
        allow_anonymous true

        listener 8883
        protocol mqtt
        allow_anonymous true
        cafile /mosquitto/certs/ca.crt
        certfile /mosquitto/certs/server.crt
        keyfile /mosquitto/certs/server.key

        listener 8884
        protocol mqtt
        allow_anonymous true
        cafile /mosquitto/certs/ca.crt
        certfile /mosquitto/certs/server.crt
        keyfile /mosquitto/certs/server.key
        require_certificate true

        listener 9001
        protocol websockets
        allow_anonymous true

        listener 9443
        protocol websockets
        allow_anonymous true
        cafile /mosquitto/certs/ca.crt
        certfile /mosquitto/certs/server.crt
        keyfile /mosquitto/certs/server.key
        """;

    private readonly IContainer _container;

    public TransportMosquittoFixture()
    {
        Certificates = new TestCertificates();

        _container = new ContainerBuilder("eclipse-mosquitto:2")
            .WithPortBinding(1883, assignRandomHostPort: true)
            .WithPortBinding(8883, assignRandomHostPort: true)
            .WithPortBinding(8884, assignRandomHostPort: true)
            .WithPortBinding(9001, assignRandomHostPort: true)
            .WithPortBinding(9443, assignRandomHostPort: true)
            .WithResourceMapping(Encoding.UTF8.GetBytes(Config), "/mosquitto/config/mosquitto.conf")
            .WithBindMount(Certificates.Directory, "/mosquitto/certs")
            .WithWaitStrategy(Wait.ForUnixContainer().UntilInternalTcpPortIsAvailable(9443))
            .Build();
    }

    public TestCertificates Certificates { get; }

    public string Host => _container.Hostname;

    public int Plain => _container.GetMappedPublicPort(1883);
    public int Tls => _container.GetMappedPublicPort(8883);
    public int MutualTls => _container.GetMappedPublicPort(8884);
    public int WebSocket => _container.GetMappedPublicPort(9001);
    public int SecureWebSocket => _container.GetMappedPublicPort(9443);

    public Task InitializeAsync() => _container.StartAsync();

    public async Task DisposeAsync()
    {
        await _container.DisposeAsync();
        Certificates.Dispose();
    }
}

// Mosquitto 1.5, which predates MQTT 5 entirely and refuses a CONNECT at protocol level 5.
//
// 1.5 and not 1.6: MQTT 5 arrived in mosquitto 1.6.0, so the last of the 1.x line answers a v5
// CONNECT perfectly happily — measured, after 1.6 was picked for this on the assumption that it
// did not. This is the only broker in the suite that makes the version ladder do anything.
public sealed class LegacyMosquittoFixture : IAsyncLifetime
{
    private readonly IContainer _container = new ContainerBuilder("eclipse-mosquitto:1.5")
        .WithPortBinding(1883, assignRandomHostPort: true)
        .WithResourceMapping(
            Encoding.UTF8.GetBytes("listener 1883\nallow_anonymous true\n"),
            "/mosquitto/config/mosquitto.conf")
        .WithWaitStrategy(Wait.ForUnixContainer().UntilInternalTcpPortIsAvailable(1883))
        .Build();

    public string Host => _container.Hostname;
    public int Port => _container.GetMappedPublicPort(1883);

    public Task InitializeAsync() => _container.StartAsync();
    public Task DisposeAsync() => _container.DisposeAsync().AsTask();
}
