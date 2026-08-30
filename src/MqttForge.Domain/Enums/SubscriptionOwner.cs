namespace MqttForge.Domain.Enums;

/// <summary>Who asked for a subscription, and therefore who is entitled to give it up.</summary>
// A flags enum rather than two lists of filters, because the question every unsubscribe has to
// answer is "is anybody else still holding this one?" and a set of bits answers it in a word.
//
// Two owners and not more, deliberately. The console subscribes what the reader typed; the
// alerting engine subscribes what the rules need, and re-subscribes the lot on every reconnect.
// They overlap constantly — a reader watching 'plant/#' while a rule watches the same tree is
// the ordinary case — and before this the second unsubscribe silently took the first one's
// traffic away.
[Flags]
public enum SubscriptionOwner
{
    None = 0,
    Console = 1,
    Rules = 2,
}
