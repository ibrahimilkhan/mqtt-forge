using MqttForge.Application.Alerts;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;

namespace MqttForge.Api.Realtime;

/// <summary>
/// The one <see cref="IMessageNotifier"/> the subscriber knows about, and the place the message
/// path forks.
/// </summary>
// The recording spec settled this shape first and recording was never built; this is the class it
// described, written for the engine instead, and recording joins it as a third target rather than
// as a third constructor parameter on MqttnetSubscriber. The subscriber goes on knowing that it
// hands a message over and nothing about who to.
//
// The policy is that nobody waits for anybody. This method is awaited inside MQTTnet's receive
// handler — the reason SignalRMessageNotifier exists at all — so every target is called on the
// caller's thread inside its own try/catch, and the fan-out returns a completed task without
// awaiting any of them.
//
// Task.WhenAll over the targets was considered and rejected. It reads as the careful option and
// is the dangerous one: it gives every target a veto over the broker connection, which is exactly
// the failure the console's queue was introduced to end. A message the engine never sees costs
// one alert, counted and shown in the panel; a receive loop the engine can stall costs every
// topic on the console.
//
// Both real targets write to a bounded channel and return, so there is genuinely nothing to wait
// for. Anything that does take time here is a broken target rather than a slow one, and it is
// left to finish on its own.
public sealed class FanOutMessageNotifier : IMessageNotifier
{
    private readonly IReadOnlyList<IMessageNotifier> _targets;

    private int _faults;

    /// <summary>How many times a target failed to take a message. Swallowing without counting
    /// would make a target that quietly stopped receiving look exactly like a quiet broker.</summary>
    public int Faults => Volatile.Read(ref _faults);

    /// <summary>What DI builds: the console first, because that is today's path unchanged, and
    /// the engine behind it.</summary>
    public FanOutMessageNotifier(SignalRMessageNotifier console, AlertEngine alerts)
        : this([console, new EngineTarget(alerts)])
    {
    }

    /// <summary>The shape the class really is: a set of targets, each of which gets everything.</summary>
    public FanOutMessageNotifier(IReadOnlyList<IMessageNotifier> targets) => _targets = targets;

    public Task NotifyMessageReceivedAsync(MqttMessage message)
    {
        foreach (var target in _targets)
        {
            try
            {
                var handing = target.NotifyMessageReceivedAsync(message);
                if (!handing.IsCompletedSuccessfully) Watch(handing);
            }
            catch (Exception)
            {
                // Where this would land if it were rethrown is MQTTnet's receive handler, where
                // it means "this connection had a problem" — a lie about the broker told on
                // behalf of a target that had a bad second.
                Interlocked.Increment(ref _faults);
            }
        }

        return Task.CompletedTask;
    }

    // Not an await: the point is that the caller has already gone. A task that is already faulted
    // runs this inline and is counted before the caller returns; one that is still running is
    // counted whenever it ends, if it ends badly. Reading Exception is what marks it observed, so
    // that a target's failure does not resurface much later on the finaliser thread as an
    // unobserved task exception nobody can trace back to a message.
    private void Watch(Task handing) =>
        handing.ContinueWith(
            failed =>
            {
                _ = failed.Exception;
                Interlocked.Increment(ref _faults);
            },
            CancellationToken.None,
            TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);

    // AlertEngine is not registered as an IMessageNotifier, and should not be: there is exactly
    // one of those in the container and it is this class. The adapter costs a field and keeps the
    // registration honest.
    private sealed class EngineTarget(AlertEngine engine) : IMessageNotifier
    {
        public Task NotifyMessageReceivedAsync(MqttMessage message) =>
            engine.NotifyMessageReceivedAsync(message);
    }
}
