namespace MqttForge.Domain.Models;

/// <summary>
/// A connection somebody chose to keep, under a name they chose for it.
/// </summary>
/// <remarks>
/// Kept apart from the settings the console writes after every successful connect. Those are a
/// cache — "the last thing that worked", overwritten without asking — and this is a decision:
/// it is written when somebody presses Save, and it stays until they delete it.
///
/// The name is what the reader finds it by. Saving under a name that is already here replaces it,
/// which is what somebody correcting a port on a broker they already saved means by pressing Save
/// again — and the one replaced keeps its <see cref="Id"/>.
///
/// The id is what other things hold on to. Colour and alert rules can belong to one broker, and
/// a rule holding a name would be left holding nothing the day the name changed; an id outlives
/// the name, the address and everything else about the broker that can be corrected. Null only
/// on the way in — a profile not yet saved, or one read from a file written before ids — and
/// the store gives it one.
/// </remarks>
public sealed record SavedBrokerProfile(string Name, BrokerConnectionSettings Settings, string? Id = null)
{
    /// <summary>A new id, for a profile that has none.</summary>
    public static string NewId() => Guid.NewGuid().ToString("N");
}
