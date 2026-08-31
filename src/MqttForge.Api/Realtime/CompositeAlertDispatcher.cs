using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;

namespace MqttForge.Api.Realtime;

/// <summary>
/// The one <see cref="IAlertDispatcher"/> the engine holds: the webhook, and the broker.
/// </summary>
// The engine takes a single dispatcher and there are two channels to give it, so something has to
// hold both. That is why this exists; the reasons it is a composite rather than a loop inside the
// engine are that the two fail in completely different ways — an endpoint that has moved, a broker
// that is down — and that neither may cost the other.
//
// The engine's own try/catch is not enough on its own. It wraps the notifier and the dispatcher
// together, so a dispatcher throwing on the way past could skip whichever of them had not been
// called yet. Containing each target here makes that ordering question stop mattering.
//
// Which targets are in the list is the container's decision, not this class's: a build with
// webhooks off is handed one target, and there is deliberately no flag here to check.
public sealed class CompositeAlertDispatcher : IAlertDispatcher
{
    private readonly ILogger<CompositeAlertDispatcher> _log;

    private int _faults;

    /// <summary>The channels this build actually holds.</summary>
    // Public because it is the only way anything can say which channels a build has. A container
    // that quietly dropped one would look exactly like a container whose endpoint was unreachable.
    public IReadOnlyList<IAlertDispatcher> Targets { get; }

    /// <summary>How many times a channel failed to take what it was given.</summary>
    public int Faults => Volatile.Read(ref _faults);

    public CompositeAlertDispatcher(
        IReadOnlyList<IAlertDispatcher> targets, ILogger<CompositeAlertDispatcher> log)
    {
        Targets = targets;
        _log = log;
    }

    public Task RaisedAsync(IReadOnlyList<Alert> alerts) =>
        EachAsync(target => target.RaisedAsync(alerts), nameof(RaisedAsync));

    public Task ResolvedAsync(IReadOnlyList<Alert> alerts) =>
        EachAsync(target => target.ResolvedAsync(alerts), nameof(ResolvedAsync));

    private async Task EachAsync(Func<IAlertDispatcher, Task> send, string call)
    {
        foreach (var target in Targets)
        {
            try
            {
                await send(target);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                Interlocked.Increment(ref _faults);
                _log.LogError(ex,
                    "{Dispatcher} threw on {Call}. The other alert channels were sent anyway.",
                    target.GetType().Name, call);
            }
        }
    }
}
