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
    bool Replay = false);
