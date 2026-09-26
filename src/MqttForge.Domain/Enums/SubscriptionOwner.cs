namespace MqttForge.Domain.Enums;

/// <summary>Who asked for a subscription, and therefore who is entitled to give it up.</summary>
// A flags enum rather than two lists of filters, because the question every unsubscribe has to
// answer is "is anybody else still holding this one?" and a set of bits answers it in a word.
//
// Three owners now. The console subscribes what the reader typed; the alerting engine subscribes
// what the rules need; the flow engine subscribes what the running flows' MQTT in nodes need. Each
// re-subscribes its own set on every reconnect, and they overlap constantly — a reader watching
// 'plant/#' while a rule and a flow watch the same tree is the ordinary case. Before owners
// existed the second unsubscribe silently took the first one's traffic away.
[Flags]
public enum SubscriptionOwner
{
    None = 0,
    Console = 1,
    Rules = 2,
    Flows = 4,
}
