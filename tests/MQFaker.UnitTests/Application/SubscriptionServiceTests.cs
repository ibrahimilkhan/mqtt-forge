using MQFaker.Application.Services;
using MQFaker.Domain.Abstractions;
using MQFaker.Domain.Models;
using NSubstitute;
using Xunit;

namespace MQFaker.UnitTests.Application;

public class SubscriptionServiceTests
{
    private readonly IMqttSubscriber _subscriber = Substitute.For<IMqttSubscriber>();

    private SubscriptionService CreateSut() => new(_subscriber);

    [Fact]
    public async Task SubscribeAsync_delegates_to_subscriber()
    {
        var sut = CreateSut();
        var request = new SubscriptionRequest("sensors/+/temp", 1);

        await sut.SubscribeAsync(request, CancellationToken.None);

        await _subscriber.Received(1).SubscribeAsync(request, Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task UnsubscribeAsync_delegates_to_subscriber()
    {
        var sut = CreateSut();

        await sut.UnsubscribeAsync("sensors/#", CancellationToken.None);

        await _subscriber.Received(1).UnsubscribeAsync("sensors/#", Arg.Any<CancellationToken>());
    }

    [Fact]
    public void ActiveFilters_reflects_subscriber_state()
    {
        _subscriber.ActiveFilters.Returns(new[] { "sensors/#", "factory/+/rpm" });
        var sut = CreateSut();

        Assert.Equal(new[] { "sensors/#", "factory/+/rpm" }, sut.ActiveFilters);
    }
}
