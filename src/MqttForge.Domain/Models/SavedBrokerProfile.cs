namespace MqttForge.Domain.Models;

/// <summary>
/// A connection somebody chose to keep, under a name they chose for it.
/// </summary>
/// <remarks>
/// Kept apart from the settings the console writes after every successful connect. Those are a
/// cache — "the last thing that worked", overwritten without asking — and this is a decision:
/// it is written when somebody presses Save, and it stays until they delete it.
///
/// The name is the identity. Saving under a name that is already here replaces it, which is what
/// somebody correcting a port on a broker they already saved means by pressing Save again.
/// </remarks>
public sealed record SavedBrokerProfile(string Name, BrokerConnectionSettings Settings);
