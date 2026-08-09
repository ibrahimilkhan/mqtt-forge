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

    public Task InitializeAsync() => _container.StartAsync();
    public Task DisposeAsync() => _container.DisposeAsync().AsTask();
}
