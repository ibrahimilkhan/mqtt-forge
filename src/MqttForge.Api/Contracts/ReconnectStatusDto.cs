using MqttForge.Domain.Models;

namespace MqttForge.Api.Contracts;

/// <summary>The supervisor's picture, in the shape the console reads it in.</summary>
// NextAttemptAt goes out as an absolute instant rather than "seconds remaining". A number of
// seconds is stale the moment it is serialised, and the console has to count down anyway — an
// instant it can subtract its own clock from is the one form that does not go wrong in transit.
public sealed record ReconnectStatusDto(
    bool Enabled, bool Active, int Attempt, DateTimeOffset? NextAttemptAt, bool GaveUp)
{
    public static ReconnectStatusDto Of(ReconnectStatus status) =>
        new(status.Enabled, status.Active, status.Attempt, status.NextAttemptAt, status.GaveUp);
}
