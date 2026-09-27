using System.Security.Cryptography;
using System.Text;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Flows;

/// <summary>What a flow has just published, so it does not answer itself.</summary>
// A hash and not the payload: a thousand 64 KB payloads is 64 MB held to answer "was that me?".
// Keyed by topic first, so the common arrival — a topic this flow never published to — costs a
// dictionary miss and no hashing at all. Not consumed on a match: a broker may deliver one
// publish twice to a client with overlapping subscriptions, and the second copy would loop.
//
// A hash of the bytes on both sides, never of text. What goes out is the rendered payload's
// UTF-8; what comes back is text only when those bytes read as text, and base64 of them when
// they do not (PayloadText) — a payload holding one control byte would otherwise never be
// recognised, and a flow publishing it to its own filter would answer itself for ever.
//
// The thousand is a ceiling the rate limit keeps it well under — a burst of fifty, and fifty a second
// for the five seconds a hash is kept, is three hundred — and it is here for the day that changes,
// so that no rate a flow can be given makes this hold more than a thousand hashes.
public sealed class FlowEchoSet
{
    private readonly Dictionary<string, List<(string Hash, DateTimeOffset Until)>> _byTopic = new(StringComparer.Ordinal);
    private readonly Queue<(string Topic, string Hash, DateTimeOffset Until)> _order = new();

    public void Remember(string topic, byte[] payload, DateTimeOffset now)
    {
        Expire(now);
        if (_order.Count >= FlowLimits.EchoFingerprints) Forget(_order.Dequeue());

        var entry = (Hash(payload), now + FlowLimits.EchoWindow);
        if (!_byTopic.TryGetValue(topic, out var list)) _byTopic[topic] = list = [];
        list.Add(entry);
        _order.Enqueue((topic, entry.Item1, entry.Item2));
    }

    public bool Heard(MqttMessage message, DateTimeOffset now)
    {
        Expire(now);
        if (!_byTopic.TryGetValue(message.Topic, out var list)) return false;

        var hash = Hash(BytesOf(message));
        return list.Exists(entry => entry.Hash == hash);
    }

    /// <summary>The bytes the broker delivered, as near as the message can say.</summary>
    private static byte[] BytesOf(MqttMessage message)
    {
        if (message.PayloadEncoding == MqttMessage.Base64)
        {
            try
            {
                return Convert.FromBase64String(message.Payload);
            }
            catch (FormatException)
            {
                // Marked base64 and not base64. The text is then the only thing to compare,
                // and an arrival is never a reason for the runtime to throw.
            }
        }

        return Encoding.UTF8.GetBytes(message.Payload);
    }

    private void Expire(DateTimeOffset now)
    {
        while (_order.TryPeek(out var oldest) && oldest.Until <= now) Forget(_order.Dequeue());
    }

    private void Forget((string Topic, string Hash, DateTimeOffset Until) entry)
    {
        if (!_byTopic.TryGetValue(entry.Topic, out var list)) return;

        list.Remove((entry.Hash, entry.Until));
        if (list.Count == 0) _byTopic.Remove(entry.Topic);
    }

    private static string Hash(byte[] payload) => Convert.ToHexString(SHA1.HashData(payload));
}
