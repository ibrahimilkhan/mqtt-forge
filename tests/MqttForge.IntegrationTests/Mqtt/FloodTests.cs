using System.Diagnostics;
using System.Text;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Mqtt;
using MqttForge.IntegrationTests.Support;
using MQTTnet;
using NSubstitute;
using Xunit;

namespace MqttForge.IntegrationTests.Mqtt;

/// <summary>
/// What happens when the broker sends faster than anyone reads.
///
/// Every other test here sends one message and waits for it. That answers whether the path
/// works and nothing about whether it holds: a `#` subscription on a real plant is thousands a
/// second, and the failures that matter at that rate — a notifier awaited one message at a time,
/// a payload decoded twice, an ordering that quietly reverses — are all invisible at one.
///
/// The budgets below are deliberately loose. They are not a benchmark; they are there to fail
/// when something goes quadratic, which is the shape of every performance bug this path has room
/// for. A run that takes twice as long on a slower machine still passes; one that takes a
/// hundred times as long because the count went up tenfold does not.
/// </summary>
public class FloodTests : IClassFixture<MosquittoFixture>
{
    private readonly MosquittoFixture _broker;

    public FloodTests(MosquittoFixture broker) => _broker = broker;

    private BrokerConnectionSettings Settings(string clientId) =>
        new(_broker.Host, _broker.Port, clientId, null, null, false);

    /// <summary>Counts what arrives and keeps the order it arrived in, without blocking delivery.</summary>
    private static (IMessageNotifier Notifier, List<MqttMessage> Seen) Recorder()
    {
        var seen = new List<MqttMessage>();
        var notifier = Substitute.For<IMessageNotifier>();
        notifier
            .NotifyMessageReceivedAsync(Arg.Do<MqttMessage>(m =>
            {
                lock (seen) seen.Add(m);
            }))
            .Returns(Task.CompletedTask);

        return (notifier, seen);
    }

    private static async Task<IMqttClient> PublisherOn(MosquittoFixture broker)
    {
        var client = new MqttClientFactory().CreateMqttClient();
        await client.ConnectAsync(new MqttClientOptionsBuilder()
            .WithTcpServer(broker.Host, broker.Port).Build());

        return client;
    }

    /// <summary>Waits for a count to settle, rather than for a fixed time nobody can justify.</summary>
    private static async Task<bool> Settles(Func<int> count, int wanted, TimeSpan within)
    {
        var until = Stopwatch.StartNew();
        while (until.Elapsed < within)
        {
            if (count() >= wanted) return true;
            await Task.Delay(25);
        }

        return count() >= wanted;
    }

    [Fact]
    public async Task Five_thousand_messages_on_one_topic_all_arrive_and_keep_their_order()
    {
        const int flood = 5000;
        var (notifier, seen) = Recorder();

        using var provider = new MqttnetClientProvider();
        var manager = new MqttnetConnectionManager(provider, Substitute.For<IConnectionStateNotifier>());
        var subscriber = new MqttnetSubscriber(provider, notifier);

        await manager.ConnectAsync(Settings("flood-one-topic"), CancellationToken.None);
        await subscriber.SubscribeAsync([new SubscriptionRequest("flood/#", 0)], CancellationToken.None);

        using var publisher = await PublisherOn(_broker);
        var sending = Stopwatch.StartNew();
        for (var i = 0; i < flood; i++) await publisher.PublishStringAsync("flood/seq", i.ToString());
        sending.Stop();

        Assert.True(
            await Settles(() => seen.Count, flood, TimeSpan.FromSeconds(60)),
            $"only {seen.Count} of {flood} arrived");

        // QoS 0 over one TCP connection is ordered, and the console draws a run in the order it
        // is given: a path that reordered under load would draw a sensor going backwards.
        List<MqttMessage> arrived;
        lock (seen) arrived = [.. seen];
        var order = arrived.Select(m => int.Parse(m.Payload)).ToArray();
        Assert.Equal(Enumerable.Range(0, flood), order);
    }

    [Fact]
    public async Task A_thousand_topics_deep_enough_to_build_a_tree_all_arrive()
    {
        const int topics = 1000;
        var (notifier, seen) = Recorder();

        using var provider = new MqttnetClientProvider();
        var manager = new MqttnetConnectionManager(provider, Substitute.For<IConnectionStateNotifier>());
        var subscriber = new MqttnetSubscriber(provider, notifier);

        await manager.ConnectAsync(Settings("flood-many-topics"), CancellationToken.None);
        await subscriber.SubscribeAsync([new SubscriptionRequest("plant/#", 0)], CancellationToken.None);

        using var publisher = await PublisherOn(_broker);
        for (var i = 0; i < topics; i++)
        {
            await publisher.PublishStringAsync($"plant/line{i % 20}/cell{i % 50}/sensor{i}/temp", $"{20 + i % 9}");
        }

        Assert.True(
            await Settles(() => seen.Count, topics, TimeSpan.FromSeconds(60)),
            $"only {seen.Count} of {topics} arrived");

        List<MqttMessage> arrived;
        lock (seen) arrived = [.. seen];
        Assert.Equal(topics, arrived.Select(m => m.Topic).Distinct().Count());
    }

    [Fact]
    public async Task Payloads_from_empty_to_a_megabyte_arrive_whole_and_in_the_right_form()
    {
        var sizes = new[] { 0, 1, 512, 64 * 1024, 1024 * 1024 };
        var (notifier, seen) = Recorder();

        using var provider = new MqttnetClientProvider();
        var manager = new MqttnetConnectionManager(provider, Substitute.For<IConnectionStateNotifier>());
        var subscriber = new MqttnetSubscriber(provider, notifier);

        await manager.ConnectAsync(Settings("flood-sizes"), CancellationToken.None);
        await subscriber.SubscribeAsync([new SubscriptionRequest("sizes/#", 0)], CancellationToken.None);

        using var publisher = await PublisherOn(_broker);
        foreach (var size in sizes)
        {
            // 'a' repeated: text, so it must come back as text however long it is.
            await publisher.PublishStringAsync($"sizes/text/{size}", new string('a', size));
            // A byte no text carries, so it must come back base64 whatever else is in it.
            await publisher.PublishBinaryAsync($"sizes/binary/{size}", Bytes(size));
        }

        Assert.True(
            await Settles(() => seen.Count, sizes.Length * 2, TimeSpan.FromSeconds(60)),
            $"only {seen.Count} of {sizes.Length * 2} arrived");

        List<MqttMessage> arrived;
        lock (seen) arrived = [.. seen];
        foreach (var size in sizes)
        {
            var text = arrived.Single(m => m.Topic == $"sizes/text/{size}");
            Assert.Equal(PayloadText.Text, text.PayloadEncoding);
            Assert.Equal(size, text.Payload.Length);

            var binary = arrived.Single(m => m.Topic == $"sizes/binary/{size}");
            // Zero bytes is text-shaped whichever way it was sent: there is nothing in it that
            // is not text, and a reader would rather see nothing than 'AA=='.
            Assert.Equal(size == 0 ? PayloadText.Text : PayloadText.Base64, binary.PayloadEncoding);
            Assert.Equal(size, Convert.FromBase64String(binary.Payload.Length == 0 ? "" : binary.Payload).Length);
        }
    }

    /// <summary>A run of bytes with a control byte in it, so it is binary at any length.</summary>
    private static byte[] Bytes(int size) =>
        [.. Enumerable.Range(0, size).Select(i => (byte)(i % 256))];

    [Fact]
    public async Task Ten_thousand_arrivals_are_decoded_in_about_the_time_a_thousand_take()
    {
        // The path this measures is PayloadText.Describe, which every arrival passes through and
        // which is the one place on the hot path that looks at every byte. Ten times the
        // messages should cost about ten times the work; it is the *shape* being asserted, so
        // the allowance is wide enough that a slow machine or a noisy one still passes.
        var body = Encoding.UTF8.GetBytes(new string('x', 512));

        var thousand = Time(1000, body);
        var tenThousand = Time(10_000, body);

        Assert.True(
            tenThousand < thousand * 40 + TimeSpan.FromSeconds(1),
            $"1k took {thousand.TotalMilliseconds:F0}ms, 10k took {tenThousand.TotalMilliseconds:F0}ms — that is not linear");
    }

    private static TimeSpan Time(int count, byte[] body)
    {
        var sequence = new System.Buffers.ReadOnlySequence<byte>(body);
        var clock = Stopwatch.StartNew();
        for (var i = 0; i < count; i++) PayloadText.Describe(sequence);

        return clock.Elapsed;
    }
}
