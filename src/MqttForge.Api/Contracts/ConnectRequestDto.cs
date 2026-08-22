using MqttForge.Domain.Enums;

namespace MqttForge.Api.Contracts;

// Everything after UseTls is defaulted, so a console that has not learnt about transports or
// versions yet still connects the way it always did — and so does an old saved connection
// replayed through this endpoint.
public record ConnectRequestDto(
    string Host,
    int Port,
    string ClientId,
    string? Username,
    string? Password,
    bool UseTls,
    MqttTransport Transport = MqttTransport.Tcp,
    MqttProtocolLevel ProtocolVersion = MqttProtocolLevel.Auto,
    string? WebSocketPath = null,
    bool CleanSession = true,
    uint? SessionExpiryInterval = null,
    TlsOptionsDto? Tls = null);

// The parts of TLS that need a field. Sent as its own object rather than flattened, so a form
// that shows none of this sends nothing at all rather than seven nulls.
public sealed record TlsOptionsDto(
    bool AllowUntrustedCertificates = false,
    string? CertificateAuthorityPath = null,
    string? ClientCertificatePath = null,
    string? ClientCertificateKeyPath = null,
    string? ClientCertificatePassword = null,
    string? SniHost = null,
    string? AlpnProtocol = null);
