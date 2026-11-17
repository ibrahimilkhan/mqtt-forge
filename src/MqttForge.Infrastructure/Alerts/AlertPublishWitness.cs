using MqttForge.Domain.Models;

namespace MqttForge.Infrastructure.Alerts;

/// <summary>
/// The last alert publish, kept for long enough to say whether the broker hung up over it.
/// </summary>
/// <remarks>
/// A broker that will not take a PUBLISH is allowed to answer by closing the session, and the
/// public ones that only let readers read do exactly that: no PUBACK, no reason code naming the
/// topic, the socket simply goes. What arrives here is "the connection was lost", which sends the
/// reader to look at their network while the thing to change is an alert rule.
///
/// Nothing on the wire connects the two, so the timing does. The dispatcher says where a rule is
/// about to publish; the connection manager, when a link it had drops, asks whether that happened
/// a moment ago. Written before the publish rather than after it, because at QoS 0 the hang-up can
/// land before the call that sent it has returned.
/// </remarks>
public sealed class AlertPublishWitness
{
    // Long enough for a broker across the internet to read the packet and close, which measured
    // against mqtt.hsl.fi is well under a second; short enough that a link dropping for some other
    // reason a while after an alarm is not pinned on it.
    public static readonly TimeSpan Window = TimeSpan.FromSeconds(3);

    private readonly TimeProvider _time;
    private readonly Lock _lock = new();
    private (RefusedPublish Publish, long At)? _last;

    public AlertPublishWitness(TimeProvider? time = null) => _time = time ?? TimeProvider.System;

    /// <summary>A rule is about to publish to a topic.</summary>
    public void Saw(string rule, string topic)
    {
        lock (_lock) _last = (new RefusedPublish(rule, topic), _time.GetTimestamp());
    }

    /// <summary>The publish that went within the window, or null.</summary>
    public RefusedPublish? Recent()
    {
        lock (_lock)
        {
            if (_last is not { } last) return null;

            return _time.GetElapsedTime(last.At) <= Window ? last.Publish : null;
        }
    }

    /// <summary>A new link: nothing published on the last one is this one's business.</summary>
    public void Forget()
    {
        lock (_lock) _last = null;
    }
}
