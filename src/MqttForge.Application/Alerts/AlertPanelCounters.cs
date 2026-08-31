namespace MqttForge.Application.Alerts;

/// <summary>
/// The two numbers the alerts panel shows that <see cref="AlertSnapshot"/> cannot carry.
/// </summary>
// Both are facts about things happening outside the core, which is why neither can live on the
// snapshot: the core is a pure function of the messages and rules it is handed, and it has no
// idea whether a webhook queue overflowed or whether there is a broker on the other end at all.
//
// One class for the two rather than one each. They are read together, by one endpoint, once per
// panel refresh, and a second singleton with a single member on it would be a second registration
// and a second thing to look for when someone asks where a number on the panel comes from.
//
// Written by two threads and read by a third — the webhook dispatcher's channel callback, the
// supervisor's poll, and a Kestrel thread on GET /api/alerts — so every access here is
// interlocked or volatile. None of it is a lock, because none of it is a decision: these are
// counters, and a reader that catches the value from a moment ago is showing a panel that is one
// refresh behind, which it always is anyway.
public sealed class AlertPanelCounters
{
    private readonly TimeProvider _time;

    private int _webhooksDropped;

    /// When the engine was first seen unable to see anything, in UTC ticks. Zero means it can.
    private long _blindSince;

    // MqttnetConnectionManager's signature exactly, and BrokerLinkSupervisor's: production wires
    // nothing and a test hands in a clock it can move. The container fills every other parameter
    // it is given and leaves this one at its default, because TimeProvider is deliberately not
    // registered anywhere in this app.
    public AlertPanelCounters(TimeProvider? timeProvider = null) => _time = timeProvider ?? TimeProvider.System;

    /// <summary>Alert deliveries the webhook queue had to discard because it was full.</summary>
    public int WebhooksDropped => Volatile.Read(ref _webhooksDropped);

    /// <summary>Counted, never logged per occurrence: a full queue is a burst, not an event.</summary>
    public void WebhookDropped() => Interlocked.Increment(ref _webhooksDropped);

    /// <summary>The engine cannot see the broker. Called on every poll; only the first one counts.</summary>
    // Idempotent on purpose. The supervisor calls this once a second for as long as the link is
    // down, and a version that restamped the moment on each call would report "blind for 1 second"
    // for ever — which is the one answer that makes the number worthless.
    public void Blind()
    {
        if (Volatile.Read(ref _blindSince) == 0) Volatile.Write(ref _blindSince, _time.GetUtcNow().UtcTicks);
    }

    /// <summary>The link is up. The count starts again from nothing next time it goes.</summary>
    public void Seeing() => Volatile.Write(ref _blindSince, 0);

    /// <summary>
    /// How long the engine has been unable to see anything, in seconds. Zero when it can.
    /// </summary>
    // The spec asks for this in as many words — "an alerting system's silence must have a visible
    // reason" — and it is the difference between a panel that says "nothing is wrong" and one that
    // says "nothing has been looked at for four minutes". Those are opposite sentences and today
    // they draw the same empty list.
    public int BlindSeconds
    {
        get
        {
            var since = Volatile.Read(ref _blindSince);
            if (since == 0) return 0;

            var seconds = (_time.GetUtcNow() - new DateTimeOffset(since, TimeSpan.Zero)).TotalSeconds;

            // A clock that stepped backwards — an NTP correction, a container resuming — must not
            // put a negative number on the panel.
            return seconds <= 0 ? 0 : (int)seconds;
        }
    }
}
