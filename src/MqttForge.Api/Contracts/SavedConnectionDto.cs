using MqttForge.Domain.Enums;

namespace MqttForge.Api.Contracts;

// Passwords deliberately omitted — the broker's and the client certificate's alike. Only
// whether there is one comes back, so the console can say it is there and ask for it again.
public record SavedConnectionDto(
    string Host,
    int Port,
    string ClientId,
    string? Username,
    bool HasPassword,
    bool UseTls,
    MqttTransport Transport,
    MqttProtocolLevel ProtocolVersion,
    string? WebSocketPath,
    bool CleanSession,
    uint? SessionExpiryInterval,
    SavedTlsOptionsDto? Tls);

public sealed record SavedTlsOptionsDto(
    bool AllowUntrustedCertificates,
    string? CertificateAuthorityPath,
    string? ClientCertificatePath,
    string? ClientCertificateKeyPath,
    bool HasClientCertificatePassword,
    string? SniHost,
    string? AlpnProtocol);
