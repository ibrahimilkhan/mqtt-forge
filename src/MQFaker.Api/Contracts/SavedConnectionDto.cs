namespace MQFaker.Api.Contracts;

// Kaydedilmiş ayarların panele dönen hâli. Şifre bilinçli olarak yoktur;
// yalnızca kayıtlı bir şifre bulunduğu bilgisi taşınır.
public record SavedConnectionDto(
    string Host, int Port, string ClientId, string? Username, bool HasPassword, bool UseTls);
