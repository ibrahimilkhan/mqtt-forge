using System.Diagnostics;
using System.Threading.Channels;
using Microsoft.AspNetCore.SignalR;
using MqttForge.Api.Hubs;
using MqttForge.Api.Realtime;
using MqttForge.Domain.Models;
using NSubstitute;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

// A '#' subscription on a public broker outruns one websocket frame per message, and awaiting
// each send inside MQTTnet's receive handler stalls the broker connection itself.
public class MessageBatchingTests
{
    [Fact]
    public async Task Forwards_a_burst_as_one_batch()
    {
        var hub = new RecordingHub();
        var notifier = new SignalRMessageNotifier(hub.Context);

        // Queued before the pump starts, so its first drain is guaranteed to see all three.
        await notifier.NotifyMessageReceivedAsync(Message("lab/a"));
        await notifier.NotifyMessageReceivedAsync(Message("lab/b"));
        await notifier.NotifyMessageReceivedAsync(Message("lab/c"));

        await notifier.StartAsync(CancellationToken.None);
        var batch = await hub.NextBatch();
        await notifier.StopAsync(CancellationToken.None);

        Assert.Equal(["lab/a", "lab/b", "lab/c"], batch.Select(m => m.Topic));
    }

    [Fact]
    public async Task Hands_the_message_over_without_waiting_on_the_socket()
    {
        var notifier = new SignalRMessageNotifier(new RecordingHub().Context);

        var handover = notifier.NotifyMessageReceivedAsync(Message("lab/a"));

        // Nothing is reading the queue, and it still came back done: the MQTT receive loop moves on.
        Assert.True(handover.IsCompletedSuccessfully);
    }

    [Fact]
    public async Task Drops_the_oldest_message_once_the_queue_is_full()
    {
        var hub = new RecordingHub();
        var notifier = new SignalRMessageNotifier(hub.Context);

        for (var i = 0; i <= SignalRMessageNotifier.QueueCapacity; i++)
            await notifier.NotifyMessageReceivedAsync(Message($"lab/{i}"));

        await notifier.StartAsync(CancellationToken.None);
        var batch = await hub.NextBatch();
        await notifier.StopAsync(CancellationToken.None);

        // One message over capacity, so 'lab/0' is the one that went; a stale message is worth
        // less than a live one, and growing without bound is what the queue exists to prevent.
        Assert.Equal("lab/1", batch[0].Topic);
    }

    // The bug this replaced: the pump slept 100ms after every batch whatever the load, so it
    // could never send more than MaxBatchSize per tick however fast the broker was going.
    [Fact]
    public async Task Keeps_sending_under_load_instead_of_pausing_between_batches()
    {
        var hub = new RecordingHub();
        var notifier = new SignalRMessageNotifier(hub.Context);

        const int batches = 5;
        for (var i = 0; i < SignalRMessageNotifier.MaxBatchSize * batches; i++)
            await notifier.NotifyMessageReceivedAsync(Message($"lab/{i}"));

        var started = Stopwatch.StartNew();
        await notifier.StartAsync(CancellationToken.None);

        var delivered = 0;
        while (delivered < SignalRMessageNotifier.MaxBatchSize * batches)
            delivered += (await hub.NextBatch()).Count;

        started.Stop();
        await notifier.StopAsync(CancellationToken.None);

        // A pause per batch would put this past half a second on its own; the point is that a
        // backlog drains as fast as the socket takes it.
        Assert.True(
            started.ElapsedMilliseconds < 500,
            $"draining {delivered} queued messages took {started.ElapsedMilliseconds}ms");
    }

    // A quiet topic should still arrive promptly rather than waiting for a batch to build.
    [Fact]
    public async Task Pauses_to_coalesce_only_when_the_batch_was_small()
    {
        Assert.True(SignalRMessageNotifier.ShouldCoalesceAfter(1));
        Assert.True(SignalRMessageNotifier.ShouldCoalesceAfter(SignalRMessageNotifier.CoalesceBelow - 1));
        Assert.False(SignalRMessageNotifier.ShouldCoalesceAfter(SignalRMessageNotifier.CoalesceBelow));
        Assert.False(SignalRMessageNotifier.ShouldCoalesceAfter(SignalRMessageNotifier.MaxBatchSize));
    }

    // Dropping was silent before: the console simply showed fewer topics than the broker had.
    [Fact]
    public async Task Counts_what_it_had_to_drop_rather_than_losing_it_quietly()
    {
        var notifier = new SignalRMessageNotifier(new RecordingHub().Context);

        for (var i = 0; i <= SignalRMessageNotifier.QueueCapacity; i++)
            await notifier.NotifyMessageReceivedAsync(Message($"lab/{i}"));

        Assert.Equal(1, notifier.Dropped);
    }

    // Counting it was only half the job. The figure sat in a field nothing read, so the console
    // went on showing fewer topics than the broker had with nothing anywhere saying why — which
    // is the very thing counting rather than dropping quietly was for.
    [Fact]
    public async Task Tells_the_console_what_it_had_to_drop()
    {
        var hub = new RecordingHub();
        var notifier = new SignalRMessageNotifier(hub.Context);

        for (var i = 0; i <= SignalRMessageNotifier.QueueCapacity; i++)
            await notifier.NotifyMessageReceivedAsync(Message($"lab/{i}"));

        await notifier.StartAsync(CancellationToken.None);
        var total = await hub.NextDropTotal();
        await notifier.StopAsync(CancellationToken.None);

        Assert.Equal(1, total);
    }

    // Sent on a change, so a console that is keeping up never hears about it.
    [Fact]
    public async Task Says_nothing_about_drops_while_there_are_none()
    {
        var hub = new RecordingHub();
        var notifier = new SignalRMessageNotifier(hub.Context);

        await notifier.NotifyMessageReceivedAsync(Message("lab/a"));

        await notifier.StartAsync(CancellationToken.None);
        await hub.NextBatch();
        await notifier.StopAsync(CancellationToken.None);

        Assert.True(hub.SaidNothingAboutDrops);
    }

    [Fact]
    public async Task Drops_nothing_while_the_queue_has_room()
    {
        var notifier = new SignalRMessageNotifier(new RecordingHub().Context);

        await notifier.NotifyMessageReceivedAsync(Message("lab/a"));

        Assert.Equal(0, notifier.Dropped);
    }

    [Fact]
    public async Task Caps_how_much_one_frame_carries()
    {
        var hub = new RecordingHub();
        var notifier = new SignalRMessageNotifier(hub.Context);

        for (var i = 0; i < SignalRMessageNotifier.MaxBatchSize + 10; i++)
            await notifier.NotifyMessageReceivedAsync(Message($"lab/{i}"));

        await notifier.StartAsync(CancellationToken.None);
        var batch = await hub.NextBatch();
        await notifier.StopAsync(CancellationToken.None);

        Assert.Equal(SignalRMessageNotifier.MaxBatchSize, batch.Count);
    }

    private static MqttMessage Message(string topic) =>
        new(topic, "1", "text", 0, false, DateTimeOffset.UnixEpoch);

    // Captures what reaches the hub. SendAsync is an extension method, so the substitute has to
    // stand in for the SendCoreAsync underneath it.
    private sealed class RecordingHub
    {
        private readonly Channel<IReadOnlyList<MqttMessage>> _batches =
            Channel.CreateUnbounded<IReadOnlyList<MqttMessage>>();

        private readonly Channel<int> _drops = Channel.CreateUnbounded<int>();

        public RecordingHub()
        {
            var proxy = Substitute.For<IClientProxy>();
            proxy
                .SendCoreAsync(Arg.Any<string>(), Arg.Any<object?[]>(), Arg.Any<CancellationToken>())
                .Returns(call =>
                {
                    var payload = call.Arg<object?[]>()!;

                    // Two methods travel this way now, so what was sent is kept apart by which
                    // was called rather than by casting whatever turns up to a batch.
                    if (call.ArgAt<string>(0) == SignalRMessageNotifier.MessagesDropped)
                        _drops.Writer.TryWrite((int)payload[0]!);
                    else
                        _batches.Writer.TryWrite((IReadOnlyList<MqttMessage>)payload[0]!);

                    return Task.CompletedTask;
                });

            var clients = Substitute.For<IHubClients>();
            clients.All.Returns(proxy);

            Context = Substitute.For<IHubContext<MqttHub>>();
            Context.Clients.Returns(clients);
        }

        public IHubContext<MqttHub> Context { get; }

        public async Task<IReadOnlyList<MqttMessage>> NextBatch()
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            return await _batches.Reader.ReadAsync(timeout.Token);
        }

        public async Task<int> NextDropTotal()
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            return await _drops.Reader.ReadAsync(timeout.Token);
        }

        /// <summary>Whether anything has been said about drops at all.</summary>
        public bool SaidNothingAboutDrops => _drops.Reader.Count == 0;
    }
}
