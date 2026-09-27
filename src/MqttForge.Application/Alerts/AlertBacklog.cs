namespace MqttForge.Application.Alerts;

/// <summary>
/// Alert events waiting for a channel slow to take them: in the order they happened, and never
/// more than a bound.
/// </summary>
// For the two channels that must not hold up the pump feeding them — the console, which a browser
// tab that has stopped reading can hold for as long as its connection lasts, and the broker's
// alarm channel, whose broker may be slow to take each publish — and for the question both face
// once they fall behind: what to let go.
//
// Not simply the oldest. A lost end leaves an alarm standing on every console that heard it go up,
// and a retained record on the broker after the alarm is over; a lost raise hides an alarm, which
// is the failure alerting exists to prevent. What goes first is an alert that went up and came down
// while the channel was not taking, both ends of it: told neither, the channel ends where it would
// have ended told both, and the log has it all the same. Every other event stays, in its order,
// and what is left is then at most the alerts standing now, whose ends have not come, and the ends
// of those standing when the channel last took, whose raises it has.
//
// Only past the bound: a channel keeping up is told of every alert, however briefly it stood. And
// the oldest go after all if that is still too many, which no engine keeping its ceiling can make
// happen, so that the bound holds whatever it is handed.
public sealed class AlertBacklog(int bound)
{
    // A list under a lock rather than a channel: what Compact does needs the whole of it at once.
    private readonly Lock _gate = new();
    private List<AlertEvent> _events = [];

    // Alerts that came and went untold, and events let go past the bound, since the last take.
    private int _untold;
    private int _lost;

    /// <summary>How many events are waiting.</summary>
    public int Count
    {
        get { lock (_gate) return _events.Count; }
    }

    /// <summary>
    /// Events that happened after every one added before them. Never waits, and says how many
    /// waiting events it let go to stay within the bound.
    /// </summary>
    public int Add(IReadOnlyList<AlertEvent> events)
    {
        if (events.Count == 0) return 0;

        lock (_gate)
        {
            _events.AddRange(events);
            if (_events.Count <= bound) return 0;

            var before = _events.Count;
            Compact();

            return before - _events.Count;
        }
    }

    /// <summary>Everything waiting, oldest first, and what was let go since the last take. Null when there is neither.</summary>
    public Taken? Take()
    {
        lock (_gate)
        {
            if (_events.Count == 0 && _untold == 0 && _lost == 0) return null;

            var taken = new Taken(_events, _untold, _lost);
            _events = [];
            _untold = 0;
            _lost = 0;

            return taken;
        }
    }

    /// <summary>What a channel takes: the events, and how many alerts and events it will never be told of.</summary>
    public readonly record struct Taken(IReadOnlyList<AlertEvent> Events, int Untold, int Lost);

    private void Compact()
    {
        var ended = new HashSet<string>(StringComparer.Ordinal);
        foreach (var one in _events)
            if (!one.Raised) ended.Add(one.Alert.Id);

        var cameAndWent = new HashSet<string>(StringComparer.Ordinal);
        foreach (var one in _events)
            if (one.Raised && ended.Contains(one.Alert.Id)) cameAndWent.Add(one.Alert.Id);

        if (cameAndWent.Count > 0)
        {
            _events.RemoveAll(one => cameAndWent.Contains(one.Alert.Id));
            _untold += cameAndWent.Count;
        }

        if (_events.Count <= bound) return;

        var over = _events.Count - bound;
        _events.RemoveRange(0, over);
        _lost += over;
    }
}
