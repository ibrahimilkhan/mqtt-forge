using MqttForge.Domain.Models;

namespace MqttForge.Application.Alerts;

/// <summary>
/// The recent readings of one (rule, topic) pair, oldest dropped first.
/// </summary>
// Only the statistical conditions open one of these. Threshold, band, pattern, oneOf and their
// composites look at the message in hand and hold nothing at all, which is the decision that
// keeps the server's "it stores nothing" property for the rules most people write.
//
// A Queue<Reading> was the obvious alternative and was rejected for what it cannot give back:
// there is no way to hand a contiguous span of its contents to the statistics, so every fence,
// every quartile and every KS test would allocate an array and copy into it — per pair, per
// second. A List<Reading> with a rolling index is this class with the bounds checks left to the
// caller. So: an array sized once, a write head, and a count.
public sealed class TopicWindow
{
    private readonly Reading[] _readings;

    /// Where the next Add writes, which is also the oldest reading once the ring is full.
    private int _next;

    private int _count;

    public TopicWindow(int capacity)
    {
        // The engine clamps to MinWindow..MaxWindow before it gets here; this only refuses a
        // window with no room in it, which would make Add index past the end of an empty array.
        ArgumentOutOfRangeException.ThrowIfLessThan(capacity, 1);

        _readings = new Reading[capacity];
    }

    public int Capacity => _readings.Length;

    public int Count => _count;

    // 'in' so a sixteen-byte struct is passed by reference on the hottest path in the engine —
    // once per matching arrival, per rule that wants a window.
    public void Add(in Reading reading)
    {
        _readings[_next] = reading;

        // A branch rather than a modulo. The ring is written to on every arrival and read from
        // rarely, so the one place worth being plain about is this one.
        _next = _next + 1 == _readings.Length ? 0 : _next + 1;

        if (_count < _readings.Length) _count++;
    }

    public void Clear()
    {
        // The array itself is kept and not zeroed. A Reading holds no reference, so there is
        // nothing being kept alive, and the pair whose window was just emptied is the pair that
        // is about to fill it again — the outlier condition clears the ring precisely when a new
        // level has been accepted and the readings after it are the ones that matter.
        //
        // The write head goes back to nought with the count. Leaving it where it was would put
        // the next reading in the middle of an array the copy then reads oldest-first from the
        // wrong end.
        _next = 0;
        _count = 0;
    }

    /// <summary>Oldest first. Writes at most Count entries; returns how many were written.</summary>
    // The newest are the ones that survive a destination too small to hold everything, and the
    // alternative — filling from the oldest end and stopping — was rejected as the more
    // dangerous of the two. A caller with a fixed buffer would then be handed the same stale
    // prefix for ever while the live readings fell out of the far end unseen, and every fence
    // computed from it would be a fence around a window that stopped moving. Truncating to the
    // newest gives a shorter answer to the same question rather than a confident answer to
    // another one.
    public int CopyTo(Span<Reading> destination)
    {
        var wanted = Math.Min(destination.Length, _count);
        if (wanted == 0) return 0;

        var start = StartOfNewest(wanted);

        // At most two blocks, because a ring's contents are either one run or a run that has
        // wrapped. Copying reading by reading would be correct and about four times slower on
        // a two-thousand-reading window.
        var first = Math.Min(wanted, _readings.Length - start);

        _readings.AsSpan(start, first).CopyTo(destination);
        if (first < wanted) _readings.AsSpan(0, wanted - first).CopyTo(destination[first..]);

        return wanted;
    }

    /// <summary>Oldest first, values only. Writes at most Count; returns how many were written.</summary>
    // Its own method rather than a CopyTo followed by a select, because this is what the
    // statistics actually want: Tukey's quartiles sort their sample in place, and sorting the
    // ring's own array would throw away the order the window exists to keep. A contiguous
    // double[] the caller owns is exactly the thing that can be sorted without doing that.
    //
    // The loop is per reading, and it has to be: the values sit sixteen bytes apart inside
    // Reading, so there is no block of doubles here to copy.
    public int CopyValuesTo(Span<double> destination)
    {
        var wanted = Math.Min(destination.Length, _count);
        if (wanted == 0) return 0;

        var index = StartOfNewest(wanted);

        for (var i = 0; i < wanted; i++)
        {
            destination[i] = _readings[index].Value;
            index = index + 1 == _readings.Length ? 0 : index + 1;
        }

        return wanted;
    }

    /// Where the newest `wanted` readings begin. One length is enough to lift it back into
    /// range: `wanted` never exceeds the count, and the count never exceeds the capacity.
    private int StartOfNewest(int wanted) => (_next - wanted + _readings.Length) % _readings.Length;
}
