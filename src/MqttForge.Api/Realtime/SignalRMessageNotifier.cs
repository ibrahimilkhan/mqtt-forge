using System.Threading.Channels;
using Microsoft.AspNetCore.SignalR;
using MqttForge.Api.Hubs;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;

namespace MqttForge.Api.Realtime;

// Delivery concern, so it lives in Api rather than Infrastructure.
//
// A '#' subscription on a public broker arrives faster than a websocket carries frames, and the
// send used to be awaited inside MQTTnet's receive handler — so a slow socket stalled the broker
// connection itself. Messages are queued here instead and a pump forwards them in batches.
public sealed class SignalRMessageNotifier : BackgroundService, IMessageNotifier
{
    public const string MessagesReceived = "messagesReceived";

    // Deep enough to ride out a burst the console is still drawing. Past this the oldest go —
    // a stale message is worth less than a live one — but that is a last resort, not a budget,
    // and Dropped says when it happens instead of leaving the console quietly short of topics.
    public const int QueueCapacity = 32_768;

    // A ceiling on one frame, so a huge backlog arrives as several messages the browser can
    // work through rather than one it has to parse whole.
    public const int MaxBatchSize = 2_000;

    // Below this the pump waits a moment before sending, so a trickle of single messages does
    // not become a websocket frame each. At or above it there is no wait at all: the send is
    // its own coalescing window, and batches grow by themselves exactly as fast as they need to.
    public const int CoalesceBelow = 64;

    public static bool ShouldCoalesceAfter(int batchSize) => batchSize < CoalesceBelow;

    // One screen refresh. Long enough to gather a few messages, short enough to feel immediate.
    private static readonly TimeSpan CoalescePause = TimeSpan.FromMilliseconds(16);

    private readonly IHubContext<MqttHub> _hub;

    private int _dropped;

    /// How many messages the queue had to discard because the console could not keep up.
    public int Dropped => Volatile.Read(ref _dropped);

    private readonly Channel<MqttMessage> _queue;

    public SignalRMessageNotifier(IHubContext<MqttHub> hub)
    {
        _hub = hub;
        _queue = Channel.CreateBounded<MqttMessage>(
            new BoundedChannelOptions(QueueCapacity)
            {
                FullMode = BoundedChannelFullMode.DropOldest,
                SingleReader = true,
            },
            _ => Interlocked.Increment(ref _dropped));
    }

    // Returns done without touching the socket, so the MQTT receive loop is never held up.
    public Task NotifyMessageReceivedAsync(MqttMessage message)
    {
        _queue.Writer.TryWrite(message);
        return Task.CompletedTask;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            while (await _queue.Reader.WaitToReadAsync(stoppingToken))
            {
                var batch = Drain();
                if (batch.Count > 0)
                    await _hub.Clients.All.SendAsync(MessagesReceived, batch, stoppingToken);

                // Only when the broker is quiet. Pausing after a full batch was what capped the
                // whole pump at one batch per tick however fast messages were actually arriving.
                if (ShouldCoalesceAfter(batch.Count))
                    await Task.Delay(CoalescePause, stoppingToken);
            }
        }
        catch (OperationCanceledException)
        {
            // Shutdown; whatever is still queued goes with the connection anyway.
        }
    }

    private List<MqttMessage> Drain()
    {
        var batch = new List<MqttMessage>();
        while (batch.Count < MaxBatchSize && _queue.Reader.TryRead(out var message))
            batch.Add(message);

        return batch;
    }
}
