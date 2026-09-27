using System.Text;
using DotNet.Testcontainers.Builders;
using DotNet.Testcontainers.Containers;
using Xunit;

namespace MqttForge.IntegrationTests.Support;

// Starts a single Mosquitto broker container for the lifetime of the tests
public sealed class MosquittoFixture : IAsyncLifetime
{
    private readonly IContainer _container = new ContainerBuilder("eclipse-mosquitto:2")
        .WithPortBinding(1883, assignRandomHostPort: true)
        .WithResourceMapping(
            Encoding.UTF8.GetBytes("listener 1883\nallow_anonymous true\n"),
            "/mosquitto/config/mosquitto.conf")
        .WithWaitStrategy(Wait.ForUnixContainer().UntilInternalTcpPortIsAvailable(1883))
        .Build();

    public string Host => _container.Hostname;
    public int Port => _container.GetMappedPublicPort(1883);

    /// <summary>Freezes the broker: every link to it stays open, and nothing on one is answered.</summary>
    // The kernel under a paused container goes on taking packets, so this is the one way to have a
    // real broker withhold a SUBACK. A test that pauses it has the class's container to itself —
    // tests in one class run one at a time — and unpauses it on the way out.
    public Task PauseAsync() => _container.PauseAsync();

    public Task UnpauseAsync() => _container.UnpauseAsync();

    public Task InitializeAsync() => _container.StartAsync();
    public Task DisposeAsync() => _container.DisposeAsync().AsTask();
}
