using MqttForge.Application.Services;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;
using NSubstitute;
using Xunit;

namespace MqttForge.UnitTests.Application;

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

        // A lone filter still goes down as a batch, because that is the only shape the wire has.
        await _subscriber.Received(1).SubscribeAsync(
            Arg.Is<IReadOnlyList<SubscriptionRequest>>(r => r != null && r.Count == 1 && r[0] == request),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task SubscribeAsync_hands_a_whole_batch_to_the_subscriber_in_one_go()
    {
        var sut = CreateSut();
        SubscriptionRequest[] requests =
        [
            new("sensors/#", 0),
            new("lab/+/temp", 1),
        ];

        await sut.SubscribeAsync(requests, CancellationToken.None);

        await _subscriber.Received(1).SubscribeAsync(
            Arg.Is<IReadOnlyList<SubscriptionRequest>>(r => r != null && r.Count == 2),
            Arg.Any<CancellationToken>());
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
