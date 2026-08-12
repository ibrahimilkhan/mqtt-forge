using MqttForge.Application.Services;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;
using NSubstitute;
using Xunit;

namespace MqttForge.UnitTests.Application;

public class PublishServiceTests
{
    private readonly IMqttPublisher _publisher = Substitute.For<IMqttPublisher>();

    [Fact]
    public async Task PublishAsync_delegates_to_publisher()
    {
        var sut = new PublishService(_publisher);
        var request = new PublishRequest("sensors/temp", "23.5"u8.ToArray(), 1, false);

        await sut.PublishAsync(request, CancellationToken.None);

        await _publisher.Received(1).PublishAsync(request, Arg.Any<CancellationToken>());
    }
}
