namespace MqttForge.Application.Flows;

/// <summary>Where a Webhook node's posts go: the alert webhook's queue, client and gate, in production.</summary>
// In Application so the engine can hand a post on without knowing HTTP, as it hands a publish to
// IMqttPublisher. The engine is given none when MqttForge:AllowWebhooks is false, and a Webhook step
// is then a step that cannot do its job, said on its node.
public interface IFlowWebhook
{
    /// <summary>
    /// Queues a post and answers at once: true, or false when the queue is full and the post was let
    /// go. <paramref name="failed"/> is called, from another thread, with a sentence when the post is
    /// given up on.
    /// </summary>
    bool Post(FlowWebhookPost post, Action<string> failed);
}
