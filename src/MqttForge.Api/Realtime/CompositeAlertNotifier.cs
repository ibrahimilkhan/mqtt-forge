using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;

namespace MqttForge.Api.Realtime;

/// <summary>
/// The one <see cref="IAlertNotifier"/> the engine holds, and the place the alert path forks:
/// the container's log, and the console's hub.
/// </summary>
// Replacing LoggingAlertNotifier with the SignalR one was the obvious move and the wrong one. The
// deployment this whole feature was written for is a MQTTForge in Docker with no browser pointed
// at it, and a build that only told a hub would evaluate rules there and tell nobody — which is
// the spec's own measure of a channel that fails worse than one which does not exist.
//
// The log goes first. It is the target with no socket in it, so it cannot be slow and cannot
// fail; putting it first means the line is already written by the time anything can go wrong
// further down, and the container's record is the one thing a person can still read afterwards.
//
// Every target is awaited, unlike FanOutMessageNotifier which awaits nothing. The difference is
// entirely in who calls: that one is called inside MQTTnet's receive handler, where waiting costs
// the broker connection, and this one is called on the engine's own pump, which has already done
// the judging. Awaiting is what lets each target's exception be caught here, next to the name of
// the target that threw it.
public sealed class CompositeAlertNotifier : IAlertNotifier
{
    private readonly IReadOnlyList<IAlertNotifier> _targets;
    private readonly ILogger<CompositeAlertNotifier> _log;

    private int _faults;

    /// <summary>How many times a target failed to take what it was given. Containment nobody
    /// counted is indistinguishable from a channel that quietly stopped delivering.</summary>
    public int Faults => Volatile.Read(ref _faults);

    /// <summary>What DI builds: the record first, the socket second.</summary>
    public CompositeAlertNotifier(
        LoggingAlertNotifier log, SignalRAlertNotifier console, ILogger<CompositeAlertNotifier> logger)
        : this([log, console], logger)
    {
    }

    /// <summary>The shape the class really is: a set of targets, each of which gets everything.</summary>
    // Also the only way the fault policy above can be tested at all — both real targets are
    // sealed classes that cannot be made to misbehave.
    public CompositeAlertNotifier(
        IReadOnlyList<IAlertNotifier> targets, ILogger<CompositeAlertNotifier> log)
    {
        _targets = targets;
        _log = log;
    }

    public Task RaisedAsync(IReadOnlyList<Alert> alerts) =>
        EachAsync(target => target.RaisedAsync(alerts), nameof(RaisedAsync));

    public Task ResolvedAsync(IReadOnlyList<Alert> alerts) =>
        EachAsync(target => target.ResolvedAsync(alerts), nameof(ResolvedAsync));

    public Task DroppedAsync(int total) =>
        EachAsync(target => target.DroppedAsync(total), nameof(DroppedAsync));

    private async Task EachAsync(Func<IAlertNotifier, Task> tell, string call)
    {
        foreach (var target in _targets)
        {
            try
            {
                await tell(target);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                Interlocked.Increment(ref _faults);

                // Named, because "an alert notifier threw" — which is all the engine's own catch
                // could ever say — leaves a person with two channels and no way to tell which of
                // them stopped working.
                _log.LogError(ex,
                    "{Notifier} threw on {Call}. The other alert channels were told anyway.",
                    target.GetType().Name, call);
            }
        }
    }
}
