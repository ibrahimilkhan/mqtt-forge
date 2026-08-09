namespace MqttForge.Api.Contracts;

public record ConnectRequestDto(
    string Host, int Port, string ClientId, string? Username, string? Password, bool UseTls);
