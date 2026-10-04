namespace MqttForge.Domain.Models;

/// <summary>
/// A broker this console reached.
/// </summary>
/// <remarks>
/// The third thing the app remembers about brokers, and it is neither of the other two. The
/// connection settings are a cache of one link — "the last thing that worked" — and a saved
/// profile is a decision somebody made under a name they chose. This is a record: written by
/// connecting, with nothing typed and nothing chosen, so that the commonest way to lose a broker
/// — connecting to it, working, and moving on without pressing Save — stops losing it.
///
/// Saved brokers are in it too. It is a record of where the console has been, and a broker being
/// kept is no reason to leave it out of that; the two lists answer different questions.
///
/// There is no name because nobody gave it one. <see cref="Id"/> stands in: a stable digest of
/// the settings, so a row can be pointed at over HTTP without inventing a label for it.
/// </remarks>
public sealed record RecentBroker(string Id, BrokerConnectionSettings Settings, DateTimeOffset LastConnectedAt);
