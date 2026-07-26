namespace MQFaker.Api.Contracts;

// Saved settings as returned to the console. The password is deliberately absent;
// only the fact that one is stored is carried.
public record SavedConnectionDto(
    string Host, int Port, string ClientId, string? Username, bool HasPassword, bool UseTls);
