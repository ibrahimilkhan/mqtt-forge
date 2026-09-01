namespace MqttForge.Domain.Models;

/// <summary>What the supervisor is doing about a link, which is not the same as what the link is doing.</summary>
// ConnectionState answers "is there a link"; this answers "is anyone working on getting one back".
// They have to be two things. Through a reconnect the link's own state flickers Faulted →
// Connecting → Faulted once per rung, which is the truth about the socket and useless as a thing
// to show somebody: it says nothing about how many rungs have gone, when the next one is, or
// whether the ladder is even running. Folded into the state payload it would also mean re-sending
// the whole picture of the link once a second so a countdown could tick.
public sealed record ReconnectStatus(
    /// <summary>The option. Off means the supervisor does nothing at all, whatever the link does.</summary>
    bool Enabled,

    /// <summary>Whether an outage is being worked on right now.</summary>
    // Distinct from Enabled, and both are needed: "turned off" and "on, and nothing is wrong" are
    // the same screen otherwise, and only one of them is a reason to offer a Reconnect button.
    bool Active,

    /// <summary>Attempts spent on this outage. Zero while the first wait is still running.</summary>
    int Attempt,

    /// <summary>When the next attempt is due, or null when none is scheduled.</summary>
    DateTimeOffset? NextAttemptAt,

    /// <summary>This outage was called off by hand. The option is still on.</summary>
    // Per-outage, not permanent: it means "stop, I am looking at it". The next connection that
    // works re-arms the supervisor, the same way a hand-dialled link always has. The permanent
    // answer is Enabled, and it is a different control on a different part of the panel.
    bool GaveUp)
{
    /// <summary>Nothing wrong, nothing being done, and the option as it was last set.</summary>
    public static ReconnectStatus Idle(bool enabled) => new(enabled, false, 0, null, false);
}
