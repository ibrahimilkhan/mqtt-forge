using MqttForge.Domain.Models;

namespace MqttForge.Api.Contracts;

/// <summary>The supervisor's picture, in the shape the console reads it in.</summary>
// NextAttemptAt goes out as an absolute instant rather than "seconds remaining". A number of
// seconds is stale the moment it is serialised — a payload the console holds in its cache and
// reads again two rungs later would count down from a figure that expired long ago — while an
// instant stays true for as long as anybody holds it.
//
// Which leaves the clock it is an instant ON, and that is what Now is for. Both are the server's,
// so their difference is a duration and the browser can add it to its own clock. Sent the instant
// alone, a console on a machine two minutes fast would draw the skew as time remaining.
public sealed record ReconnectStatusDto(
    bool Enabled, bool Active, int Attempt, DateTimeOffset? NextAttemptAt, bool GaveUp,
    DateTimeOffset Now)
{
    public static ReconnectStatusDto Of(ReconnectStatus status, DateTimeOffset now) =>
        new(status.Enabled, status.Active, status.Attempt, status.NextAttemptAt, status.GaveUp, now);
}
