namespace MQFaker.Domain.Models;

// TopicFilter may contain wildcards: '+' for a single level, '#' for multiple levels
public record SubscriptionRequest(string TopicFilter, int Qos);
