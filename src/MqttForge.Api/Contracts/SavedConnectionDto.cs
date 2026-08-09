namespace MqttForge.Api.Contracts;

// Password deliberately omitted; only HasPassword is carried
public record SavedConnectionDto(
    string Host, int Port, string ClientId, string? Username, bool HasPassword, bool UseTls);
