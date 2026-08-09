using System.Text;
using DotNet.Testcontainers.Builders;
using DotNet.Testcontainers.Containers;
using Xunit;

namespace MqttForge.IntegrationTests.Support;

// One real user (the-real-user/the-real-password); any other credentials are rejected like a real typo
public sealed class LockedMosquittoFixture : IAsyncLifetime
{
    private readonly IContainer _container = new ContainerBuilder("eclipse-mosquitto:2")
        .WithPortBinding(1883, assignRandomHostPort: true)
        .WithResourceMapping(
            Encoding.UTF8.GetBytes("listener 1883\nallow_anonymous false\npassword_file /mosquitto/config/passwd\n"),
            "/mosquitto/config/mosquitto.conf")
        .WithEntrypoint("sh", "-c")
        .WithCommand(
            "mosquitto_passwd -b -c /mosquitto/config/passwd the-real-user the-real-password && " +
            // mosquitto drops to the mosquitto user internally; a root-owned pwfile is unreadable to it
            "chown mosquitto:mosquitto /mosquitto/config/passwd && chmod 0700 /mosquitto/config/passwd && " +
            "exec mosquitto -c /mosquitto/config/mosquitto.conf")
        .WithWaitStrategy(Wait.ForUnixContainer().UntilInternalTcpPortIsAvailable(1883))
        .Build();

    public string Host => _container.Hostname;
    public int Port => _container.GetMappedPublicPort(1883);

    public Task InitializeAsync() => _container.StartAsync();
    public Task DisposeAsync() => _container.DisposeAsync().AsTask();
}
