namespace MQFaker.Domain.Models;

// TopicFilter joker karakter içerebilir: tek seviye için '+', çok seviye için '#'
public record SubscriptionRequest(string TopicFilter, int Qos);
