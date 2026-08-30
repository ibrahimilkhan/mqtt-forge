using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Mqtt;
using MQTTnet;
using MQTTnet.Protocol;
using NSubstitute;
using Xunit;

namespace MqttForge.UnitTests.Infrastructure;

/// <summary>
/// One connection, two people asking for filters on it.
///
/// The console subscribes what the reader typed into the filter box. The alerting engine
/// subscribes what the rules need and re-subscribes the lot on every reconnect. They overlap
/// constantly — a reader watching 'plant/#' while a rule watches the same tree is the ordinary
/// case — and a subscription list that only knew whether a filter was up had no way to answer
/// the one question an unsubscribe has to ask: is anybody else still reading this?
///
/// Without an answer the reader clearing a chip silently switched off an alarm, and the alarm had
/// no way to notice: the filter was gone, so nothing arrived, so nothing was ever wrong.
/// </summary>
public class MqttnetSubscriberOwnerTests
{
    private readonly IMqttClient _client = Substitute.For<IMqttClient>();

    private MqttnetSubscriber CreateSut()
    {
        _client.IsConnected.Returns(true);
        return new MqttnetSubscriber(new MqttnetClientProvider(_client), Substitute.For<IMessageNotifier>());
    }

    private void GivenTheBrokerGrants(params string[] filters) =>
        _client
            .SubscribeAsync(Arg.Any<MqttClientSubscribeOptions>(), Arg.Any<CancellationToken>())
            .Returns(new MqttClientSubscribeResult(
                packetIdentifier: 1,
                [.. filters.Select(filter => new MqttClientSubscribeResultItem(
                    new MqttTopicFilterBuilder().WithTopic(filter).Build(),
                    MqttClientSubscribeResultCode.GrantedQoS0))],
                reasonString: string.Empty,
                []));

    private static IReadOnlyList<SubscriptionRequest> Asking(params string[] filters) =>
        [.. filters.Select(filter => new SubscriptionRequest(filter, 0))];

    // Asserted against the interface method the substitute actually implements, and never against
    // MqttClientExtensions.UnsubscribeAsync(client, topic): that overload is an extension, so
    // NSubstitute cannot intercept it, and a Received(1) written that way builds a fresh options
    // object and compares it by reference — which never matches, and whose DidNotReceive twin
    // therefore passes no matter what the code under test did.
    private async Task TheBrokerWasToldToDrop(string filter) =>
        await _client.Received(1).UnsubscribeAsync(
            Arg.Is<MqttClientUnsubscribeOptions>(o => o != null && o.TopicFilters.Contains(filter)),
            Arg.Any<CancellationToken>());

    private async Task TheBrokerWasNotToldToDrop(string filter) =>
        await _client.DidNotReceive().UnsubscribeAsync(
            Arg.Is<MqttClientUnsubscribeOptions>(o => o != null && o.TopicFilters.Contains(filter)),
            Arg.Any<CancellationToken>());

    // Every caller written before the engine existed says nothing about owners, and every one of
    // them is the console.
    [Fact]
    public async Task A_subscription_with_no_owner_named_belongs_to_the_console()
    {
        GivenTheBrokerGrants("plant/#");
        var sut = CreateSut();

        await sut.SubscribeAsync(Asking("plant/#"), CancellationToken.None);

        Assert.Equal(SubscriptionOwner.Console, Assert.Single(sut.Filters).Owners);
    }

    [Fact]
    public async Task A_filter_both_owners_asked_for_is_held_by_both()
    {
        GivenTheBrokerGrants("plant/#");
        var sut = CreateSut();

        await sut.SubscribeAsync(Asking("plant/#"), CancellationToken.None);
        await sut.SubscribeAsync(Asking("plant/#"), CancellationToken.None, SubscriptionOwner.Rules);

        var held = Assert.Single(sut.Filters);
        Assert.Equal(SubscriptionOwner.Console | SubscriptionOwner.Rules, held.Owners);
        // One filter, not two: the wire has one subscription for it and so does this list.
        Assert.Single(sut.ActiveFilters);
    }

    // The fault this whole mechanism exists for. The reader clears their chip; the rule watching
    // the same tree goes on getting messages.
    [Fact]
    public async Task One_owner_letting_go_does_not_take_the_others_subscription_away()
    {
        GivenTheBrokerGrants("plant/#");
        var sut = CreateSut();
        await sut.SubscribeAsync(Asking("plant/#"), CancellationToken.None);
        await sut.SubscribeAsync(Asking("plant/#"), CancellationToken.None, SubscriptionOwner.Rules);

        await sut.UnsubscribeAsync("plant/#", CancellationToken.None);

        await TheBrokerWasNotToldToDrop("plant/#");
        var held = Assert.Single(sut.Filters);
        Assert.Equal(SubscriptionOwner.Rules, held.Owners);
    }

    [Fact]
    public async Task The_last_owner_letting_go_unsubscribes_at_the_broker()
    {
        GivenTheBrokerGrants("plant/#");
        var sut = CreateSut();
        await sut.SubscribeAsync(Asking("plant/#"), CancellationToken.None);
        await sut.SubscribeAsync(Asking("plant/#"), CancellationToken.None, SubscriptionOwner.Rules);

        await sut.UnsubscribeAsync("plant/#", CancellationToken.None);
        await sut.UnsubscribeAsync("plant/#", CancellationToken.None, SubscriptionOwner.Rules);

        await TheBrokerWasToldToDrop("plant/#");
        Assert.Empty(sut.Filters);
        Assert.Empty(sut.ActiveFilters);
    }

    // A sole owner is the last owner, which is what every call site written before this behaved as.
    [Fact]
    public async Task A_sole_owner_letting_go_unsubscribes_at_the_broker()
    {
        GivenTheBrokerGrants("plant/#");
        var sut = CreateSut();
        await sut.SubscribeAsync(Asking("plant/#"), CancellationToken.None);

        await sut.UnsubscribeAsync("plant/#", CancellationToken.None);

        await TheBrokerWasToldToDrop("plant/#");
        Assert.Empty(sut.ActiveFilters);
    }

    // The engine reconciles by letting go of every filter its rules no longer need, and that list
    // can name filters only the console ever held. Releasing a claim nobody took is not an error
    // and must not reach the broker.
    [Fact]
    public async Task An_owner_releasing_a_filter_it_does_not_hold_changes_nothing()
    {
        GivenTheBrokerGrants("plant/#");
        var sut = CreateSut();
        await sut.SubscribeAsync(Asking("plant/#"), CancellationToken.None);

        await sut.UnsubscribeAsync("plant/#", CancellationToken.None, SubscriptionOwner.Rules);

        await TheBrokerWasNotToldToDrop("plant/#");
        Assert.Equal(SubscriptionOwner.Console, Assert.Single(sut.Filters).Owners);
    }

    [Fact]
    public async Task Unsubscribing_a_filter_nobody_holds_changes_nothing()
    {
        var sut = CreateSut();

        await sut.UnsubscribeAsync("plant/#", CancellationToken.None);

        await TheBrokerWasNotToldToDrop("plant/#");
        Assert.Empty(sut.Filters);
    }

    // Filters and ActiveFilters are the same set seen twice, and the string list stays the whole
    // truth: the console's subscription panel reads it and knows nothing about owners.
    [Fact]
    public async Task ActiveFilters_lists_what_either_owner_holds()
    {
        GivenTheBrokerGrants("plant/#");
        var sut = CreateSut();
        await sut.SubscribeAsync(Asking("plant/#"), CancellationToken.None, SubscriptionOwner.Rules);

        Assert.Contains("plant/#", sut.ActiveFilters);
    }
}
