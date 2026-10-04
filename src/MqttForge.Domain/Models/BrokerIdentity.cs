using System.Security.Cryptography;
using System.Text;

namespace MqttForge.Domain.Models;

/// <summary>
/// The id of one recorded connection, so a row in the history can be named over HTTP.
/// </summary>
/// <remarks>
/// Not what makes two connections the same broker. The history keeps one row per endpoint —
/// <see cref="BrokerConnectionSettings.Endpoint"/>, compared without regard to case, in
/// JsonRecentBrokerStore — and a reconnect to that endpoint under another client ID, username or set
/// of filters replaces the row, and so gives it a new id. This only has to tell the rows standing in
/// the file apart, which it does because no two of them share an endpoint.
///
/// Taken over every field but the passwords, which the API never hands back: a row written with one
/// and read without it would otherwise have a different id the moment it was read.
///
/// A digest rather than the string it is taken over, because the string carries a username and
/// the console puts this id in a URL.
/// </remarks>
public static class BrokerIdentity
{
    // Between the fields, and between the filters inside one. A unit separator cannot appear in
    // a hostname, a path or a topic filter, so nothing a reader types can make two different
    // connections write the same line.
    private const char Separator = '';

    public static string Of(BrokerConnectionSettings settings)
    {
        var parts = new StringBuilder()
            .Append(settings.Host).Append(Separator)
            .Append(settings.Port).Append(Separator)
            .Append(settings.ClientId).Append(Separator)
            .Append(settings.Username).Append(Separator)
            .Append(settings.UseTls).Append(Separator)
            .Append(settings.Transport).Append(Separator)
            .Append(settings.ProtocolVersion).Append(Separator)
            .Append(settings.WebSocketPath).Append(Separator)
            .Append(settings.CleanSession).Append(Separator)
            .Append(settings.SessionExpiryInterval).Append(Separator);

        var tls = settings.Tls;
        parts
            .Append(tls is null).Append(Separator)
            .Append(tls?.AllowUntrustedCertificates).Append(Separator)
            .Append(tls?.CertificateAuthorityPath).Append(Separator)
            .Append(tls?.ClientCertificatePath).Append(Separator)
            .Append(tls?.ClientCertificateKeyPath).Append(Separator)
            .Append(tls?.SniHost).Append(Separator)
            .Append(tls?.AlpnProtocol).Append(Separator);

        // Null and empty are different everywhere else in these settings — a file written before
        // subscriptions existed against a reader who asked for nothing — so they are different
        // here too.
        parts.Append(settings.Subscriptions is null
            ? "~"
            : string.Join(Separator, settings.Subscriptions));

        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(parts.ToString()));

        // Half of it. This names one of at most a handful of rows in one file, not a document in
        // a store, and a shorter id keeps the URL readable.
        return Convert.ToHexStringLower(digest)[..16];
    }
}
