namespace MqttForge.Application.Flows;

/// <summary>Where a Webhook node's posts go: the alert webhook's queue, client and gate, in production.</summary>
// In Application so the engine can hand a post on without knowing HTTP, as it hands a publish to
// IMqttPublisher. The engine is given none when MqttForge:AllowWebhooks is false, and a Webhook step
// is then a step that cannot do its job, said on its node.
public interface IFlowWebhook
{
    /// <summary>
    /// Queues a post and answers at once: true, or false when the queue is full or closed and the post
    /// was let go. <paramref name="failed"/> is called with a sentence when the post is given up on —
    /// from another thread once its attempts are spent, or from this one before the call returns when the
    /// channel will not send at all. A post answered false is never also called back, since the caller
    /// counts that refusal itself. A channel keeps to this and never throws, and the engine does not lean
    /// on it.
    /// </summary>
    bool Post(FlowWebhookPost post, Action<string> failed);
}
