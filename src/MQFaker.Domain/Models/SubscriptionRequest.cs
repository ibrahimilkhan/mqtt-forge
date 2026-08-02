namespace MQFaker.Domain.Models;

// TopicFilter wildcards: '+' single level, '#' multi-level
public record SubscriptionRequest(string TopicFilter, int Qos);
