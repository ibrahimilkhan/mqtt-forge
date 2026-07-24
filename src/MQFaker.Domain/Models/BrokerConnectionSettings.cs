namespace MQFaker.Domain.Models;

// Broker'a bağlanmak için gereken tüm parametreler
public record BrokerConnectionSettings(
    string Host,
    int Port,
    string ClientId,
    string? Username,
    string? Password,
    bool UseTls);
