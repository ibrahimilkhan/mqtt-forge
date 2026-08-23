using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

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
    SavedTlsOptionsDto? Tls)
{
    /// <summary>The settings as the console is allowed to see them.</summary>
    public static SavedConnectionDto Of(BrokerConnectionSettings settings) =>
        new(settings.Host, settings.Port, settings.ClientId, settings.Username,
            HasPassword: !string.IsNullOrEmpty(settings.Password), settings.UseTls,
            settings.Transport, settings.ProtocolVersion, settings.WebSocketPath,
            settings.CleanSession, settings.SessionExpiryInterval,
            // Null rather than an object of defaults, so a console reading this can tell a
            // connection that never touched the TLS section from one that set it all back.
            settings.Tls is null ? null : new SavedTlsOptionsDto(
                settings.Tls.AllowUntrustedCertificates,
                settings.Tls.CertificateAuthorityPath,
                settings.Tls.ClientCertificatePath,
                settings.Tls.ClientCertificateKeyPath,
                HasClientCertificatePassword: !string.IsNullOrEmpty(settings.Tls.ClientCertificatePassword),
                settings.Tls.SniHost,
                settings.Tls.AlpnProtocol));
}

/// <summary>A saved connection, under the name it was saved with.</summary>
public sealed record SavedProfileDto(string Name, SavedConnectionDto Connection);

/// <summary>What the console sends to keep one. The connection half is a connect request.</summary>
public sealed record SaveProfileRequestDto(string Name, ConnectRequestDto Connection);

public sealed record SavedTlsOptionsDto(
    bool AllowUntrustedCertificates,
    string? CertificateAuthorityPath,
    string? ClientCertificatePath,
    string? ClientCertificateKeyPath,
    bool HasClientCertificatePassword,
    string? SniHost,
    string? AlpnProtocol);
