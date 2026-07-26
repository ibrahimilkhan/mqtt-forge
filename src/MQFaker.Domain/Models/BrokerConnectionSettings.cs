namespace MQFaker.Domain.Models;

// Every parameter needed to connect to a broker
public record BrokerConnectionSettings(
    string Host,
    int Port,
    string ClientId,
    string? Username,
    string? Password,
    bool UseTls);
