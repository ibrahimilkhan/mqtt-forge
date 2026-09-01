using MqttForge.Domain.Models;

namespace MqttForge.Domain.Abstractions;

// Separate from IConnectionStateNotifier for the reason ReconnectStatus is separate from
// ConnectionState: one describes the link, the other describes the work being done on it, and a
// console reading a countdown must not have to re-read the link to do it.
public interface IReconnectStatusNotifier
{
    /// <summary>The status, and the instant on the sender's clock that it was true at.</summary>
    // The clock reading travels with it so that the countdown a console draws is right on a
    // machine whose clock is not this one's. NextAttemptAt is on the server's clock; subtracting
    // the browser's own from it would report the skew between them as time remaining. With both
    // instants in hand the console converts once, on arrival, into a deadline on its own clock.
    Task NotifyReconnectStatusChangedAsync(ReconnectStatus status, DateTimeOffset now);
}
