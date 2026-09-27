using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Flows;

/// <summary>What a flow has just published, so it does not answer itself.</summary>
// A hash of the topic and the payload, and neither of them: a thousand 64 KB payloads is 64 MB held
// to answer "was that me?", and a topic may be as long as MQTT allows, which a thousand times over is
// twice that again. The common arrival — a topic this flow never published to — still costs no
// hashing: the topic's own hash code is kept too, four bytes, as a first look that can only miss.
// Not consumed on a match: a broker may deliver one publish twice to a client with overlapping
// subscriptions, and the second copy would loop.
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
    // Each fingerprint live now, and how many of its entries are: one publish may be made twice.
    private readonly Dictionary<string, int> _live = new(StringComparer.Ordinal);

    // How many live entries have a topic of each hash code. Two topics that share one cost a
    // fingerprint, and never a wrong answer.
    private readonly Dictionary<int, int> _topics = [];

    private readonly Queue<(string Fingerprint, int Topic, DateTimeOffset Until)> _order = new();

    public void Remember(string topic, byte[] payload, DateTimeOffset now)
    {
        Expire(now);
        if (_order.Count >= FlowLimits.EchoFingerprints) Forget(_order.Dequeue());

        var entry = (Fingerprint(topic, payload), TopicKey(topic), now + FlowLimits.EchoWindow);
        _live[entry.Item1] = _live.GetValueOrDefault(entry.Item1) + 1;
        _topics[entry.Item2] = _topics.GetValueOrDefault(entry.Item2) + 1;
        _order.Enqueue(entry);
    }

    public bool Heard(MqttMessage message, DateTimeOffset now)
    {
        Expire(now);
        if (!_topics.ContainsKey(TopicKey(message.Topic))) return false;

        return _live.ContainsKey(Fingerprint(message.Topic, BytesOf(message)));
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

    private void Forget((string Fingerprint, int Topic, DateTimeOffset Until) entry)
    {
        Release(_live, entry.Fingerprint);
        Release(_topics, entry.Topic);
    }

    private static void Release<TKey>(Dictionary<TKey, int> counts, TKey key) where TKey : notnull
    {
        if (counts[key] == 1) counts.Remove(key);
        else counts[key]--;
    }

    private static int TopicKey(string topic) => StringComparer.Ordinal.GetHashCode(topic);

    // The topic's length goes in first, so that no two pairs of topic and payload are the same bytes.
    private static string Fingerprint(string topic, byte[] payload)
    {
        var topicBytes = Encoding.UTF8.GetBytes(topic);
        Span<byte> length = stackalloc byte[sizeof(int)];
        BinaryPrimitives.WriteInt32LittleEndian(length, topicBytes.Length);

        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA1);
        hash.AppendData(length);
        hash.AppendData(topicBytes);
        hash.AppendData(payload);

        return Convert.ToHexString(hash.GetHashAndReset());
    }
}
