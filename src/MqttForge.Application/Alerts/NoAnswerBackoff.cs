namespace MqttForge.Application.Alerts;

/// <summary>
/// How long a pump leaves its filters, after a broker that did not answer for them, before it asks
/// again: five seconds after the first attempt in a row the broker leaves unanswered, twice as long
/// after each one after that, and a minute at most.
/// </summary>
// Every attempt at a broker that keeps the link and does not answer holds the pump for the
// subscriber's whole deadline, ten seconds, and asked again five seconds later such a broker had the
// pump for ten seconds in every fifteen for as long as it kept the link up. Each pause longer than
// the last hands the pump back to its rules and flows, and a minute still asks often enough to catch
// a broker that has come back to itself. Short again once the broker answers, yes or no, and lifted
// altogether by a new link, which is a new answer. The reader's own save or deploy interrupts it, and
// the run goes on after. One for each pump: the alert rules and the flows each ask for their own
// filters, of the same broker.
public sealed class NoAnswerBackoff
{
    /// <summary>The pause after the first attempt in a row the broker leaves unanswered.</summary>
    // Short, because a broker that was only slow answers the next time.
    public static readonly TimeSpan First = TimeSpan.FromSeconds(5);

    /// <summary>The longest the pause grows to.</summary>
    public static readonly TimeSpan Longest = TimeSpan.FromMinutes(1);

    private int _unanswered;
    private TimeSpan _pause;
    private DateTimeOffset _until = DateTimeOffset.MinValue;

    /// <summary>The pause after <paramref name="unanswered"/> attempts in a row the broker left unanswered.</summary>
    public static TimeSpan After(int unanswered)
    {
        var pause = First;
        for (var i = 1; i < unanswered && pause < Longest; i++) pause *= 2;

        return pause < Longest ? pause : Longest;
    }

    /// <summary>The broker left one more attempt unanswered. Answers how long the next is put off.</summary>
    public TimeSpan NotAnswered(DateTimeOffset now)
    {
        _pause = After(++_unanswered);
        _until = now + _pause;

        return _pause;
    }

    /// <summary>The broker answered, yes or no: the next attempt it leaves unanswered is the first of a new run.</summary>
    public void Answered() => _unanswered = 0;

    /// <summary>A new link: nothing is put off, and the next attempt left unanswered is the first of a new run.</summary>
    public void Lift()
    {
        _unanswered = 0;
        _until = DateTimeOffset.MinValue;
    }

    /// <summary>The reader's own save or deploy: nothing is put off, and the run goes on.</summary>
    // A person who has just saved a rule or deployed a flow is waiting to see it at work, and a pause
    // of up to a minute is not theirs to sit out. So the next attempt goes at once. It is no answer,
    // though, and no new link: if the broker leaves that attempt unanswered as well, the pause after
    // it is the next of the run it interrupted, not the first again.
    public void Interrupt() => _until = DateTimeOffset.MinValue;

    /// <summary>Whether the broker did not answer so lately that asking again now would only wait on it again.</summary>
    // A pause that ends further off than the whole of the pause standing is a clock set back since,
    // and is over.
    public bool Pausing(DateTimeOffset now) => now < _until && _until - now <= _pause;
}
