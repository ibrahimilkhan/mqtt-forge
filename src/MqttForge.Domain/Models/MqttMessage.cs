using System.Text.Json.Serialization;

namespace MqttForge.Domain.Models;

public record MqttMessage(
    string Topic,
    string Payload,
    string PayloadEncoding,
    int Qos,
    bool Retain,
    DateTimeOffset ReceivedAt,
    // Whether this arrived as the broker replaying a retained last value rather than as something
    // that just happened. Appended last and defaulted to false so both existing constructions —
    // MqttnetSubscriber's receive handler and MessageBatchingTests' target-typed helper — keep
    // compiling and keep meaning 'live'.
    //
    // Deliberately not the same thing as Retain. SubscribeAsync asks for WithRetainAsPublished on
    // MQTT 5, so a device that publishes its readings retained sends live messages with
    // Retain: true; an engine that read the flag would ignore that entire plant on MQTT 5 and
    // work correctly on 3.1.1, and one piece of code cannot mean two opposite things in two
    // protocols. The subscriber sets this from the instant SUBACK arrived instead.
    //
    // A replayed message is still a real message to the console: it goes to the log and the tree
    // as any arrival does. It is only the engine that must not judge it.
    bool Replay = false,
    // What MQTT 5 sent along with it, and null for the great majority of messages — every
    // message on a 3.1.1 link and most on a 5.0 one. Appended last and defaulted so that every
    // existing construction of this record keeps compiling and keeps meaning 'carried nothing'.
    //
    // Kept off the wire when it is null (see MqttMessageDto): a console watching a firehose
    // reads a frame a second with two thousand messages in it, and `"properties":null` two
    // thousand times is a field nobody asked for in every one of them.
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    MessageProperties? Properties = null)
{
    /// <summary>The <see cref="PayloadEncoding"/> of a payload that was not text: its bytes, as base64.</summary>
    // Here, beside the field it names, rather than only in Infrastructure's PayloadText, which is
    // where the choice is made: the flow runtime in Application has to turn such a payload back into
    // bytes, and Application does not reference Infrastructure. PayloadText.Base64 is this constant,
    // so the word written and the word read cannot drift apart.
    public const string Base64 = "base64";
}
