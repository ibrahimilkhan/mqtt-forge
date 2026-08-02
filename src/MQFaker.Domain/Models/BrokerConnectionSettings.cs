namespace MQFaker.Domain.Models;

public record BrokerConnectionSettings(
    string Host,
    int Port,
    string ClientId,
    string? Username,
    string? Password,
    bool UseTls);
