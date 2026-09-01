namespace MqttForge.Domain.Abstractions;

/// <summary>Remembers whether the broker link is supervised, across restarts.</summary>
// Only the option is kept. The rest of ReconnectStatus is about an outage, and an outage does not
// outlive the process that was living through it — a container that came back up holding
// "attempt 4, next in 16 seconds" would be describing a broker nobody has tried yet.
public interface IReconnectOptionStore
{
    /// <summary>The saved option, or null when nothing has been saved and the default stands.</summary>
    Task<bool?> LoadAsync(CancellationToken ct);

    Task SaveAsync(bool enabled, CancellationToken ct);
}
