using System.Text;
using DotNet.Testcontainers.Builders;
using DotNet.Testcontainers.Containers;
using Xunit;

namespace MqttForge.IntegrationTests.Support;

/// <summary>
/// A broker that refuses anything over a kilobyte, for the one test about being refused.
///
/// The shared fixture imposes no limit, so provoking a refusal there meant publishing megabytes
/// and racing the broker: it answers an oversized PUBLISH with DISCONNECT(PacketTooLarge) and
/// then closes, so whether the client reads that reason or its own write dies of a broken pipe
/// comes down to which finishes first. On a laptop the reason won; on a CI runner the pipe did.
/// A small declared limit makes the packet small enough to finish writing, so the reason is
/// always what comes back.
/// </summary>
public sealed class SmallPacketMosquittoFixture : IAsyncLifetime
{
    public const int MaxPacketBytes = 1024;

    private readonly IContainer _container = new ContainerBuilder("eclipse-mosquitto:2")
        .WithPortBinding(1883, assignRandomHostPort: true)
        .WithResourceMapping(
            Encoding.UTF8.GetBytes($"listener 1883\nallow_anonymous true\nmax_packet_size {MaxPacketBytes}\n"),
            "/mosquitto/config/mosquitto.conf")
        .WithWaitStrategy(Wait.ForUnixContainer().UntilInternalTcpPortIsAvailable(1883))
        .Build();

    public string Host => _container.Hostname;
    public int Port => _container.GetMappedPublicPort(1883);

    public Task InitializeAsync() => _container.StartAsync();
    public Task DisposeAsync() => _container.DisposeAsync().AsTask();
}
