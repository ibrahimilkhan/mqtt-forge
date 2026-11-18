using MqttForge.Domain.Models;

namespace MqttForge.Infrastructure.Mqtt;

// What the link that is up has been carrying lately, so that a drop can say whether the broker
// had gone quiet or was still sending. One bucket a second for the last ten, each stamped with the
// second it counts, so a bucket left over from a lap ago is recognised as stale rather than summed.
//
// Recorded from MQTTnet's receive loop and read from its disconnect, which are different tasks; a
// lock taken a couple of thousand times a second for a few additions costs nothing worth measuring.
public sealed class InboundTraffic
{
    public static readonly TimeSpan Window = TimeSpan.FromSeconds(10);

    // The window's ten whole seconds and the one under way, which is where the newest arrivals are.
    private const int Buckets = 11;

    private readonly long[] _second = new long[Buckets];
    private readonly long[] _messages = new long[Buckets];
    private readonly long[] _bytes = new long[Buckets];
    private readonly Lock _lock = new();

    private DateTimeOffset _since;
    private DateTimeOffset? _last;

    /// <summary>Forgets everything: a new link has carried nothing yet.</summary>
    public void Restart(DateTimeOffset at)
    {
        lock (_lock)
        {
            Array.Clear(_second);
            Array.Clear(_messages);
            Array.Clear(_bytes);
            _since = at;
            _last = null;
        }
    }

    public void Record(DateTimeOffset at, int bytes)
    {
        var second = at.ToUnixTimeSeconds();
        var slot = (int)(second % Buckets);

        lock (_lock)
        {
            if (_second[slot] != second)
            {
                _second[slot] = second;
                _messages[slot] = 0;
                _bytes[slot] = 0;
            }

            _messages[slot]++;
            _bytes[slot] += bytes;
            _last = at;
        }
    }

    public LinkTraffic Read(DateTimeOffset now)
    {
        var newest = now.ToUnixTimeSeconds();

        lock (_lock)
        {
            long messages = 0, bytes = 0;
            for (var i = 0; i < Buckets; i++)
            {
                if (_second[i] > newest - Buckets && _second[i] <= newest)
                {
                    messages += _messages[i];
                    bytes += _bytes[i];
                }
            }

            // Over the time those buckets actually span, and over the link's own age while it is
            // younger than that: a drop three seconds in divided by ten would put a broker sending
            // 300 a second down as sending 90.
            var spanned = Window.TotalSeconds + (now - DateTimeOffset.FromUnixTimeSeconds(newest)).TotalSeconds;
            var seconds = Math.Max(1, Math.Min(spanned, (now - _since).TotalSeconds));

            return new LinkTraffic(messages / seconds, bytes / 1024.0 / seconds, now - _last);
        }
    }
}
