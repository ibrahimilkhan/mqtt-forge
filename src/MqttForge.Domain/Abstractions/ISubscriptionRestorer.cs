namespace MqttForge.Domain.Abstractions;

/// <summary>Puts back the console's subscriptions after a link that dropped has been redialled.</summary>
// Its own interface rather than a method on IMqttSubscriber, because only one caller has any
// business with it: the supervisor, on the one path where a connection was made by nobody. A
// reader's own Connect is followed by their console asking for what it wants; the alert engine
// keeps its own filters up; the supervisor's redial was followed by nothing at all, and a link
// that came back listening to nothing but the rules was the console's tree quietly going stale.
public interface ISubscriptionRestorer
{
    /// <summary>Asks the broker again for every filter the console held when the link last dropped.</summary>
    // Throws what a subscribe throws: a broker that refuses one of them says so, and the caller
    // decides what a refusal on a redial is worth telling.
    Task RestoreConsoleFiltersAsync(CancellationToken ct);
}
