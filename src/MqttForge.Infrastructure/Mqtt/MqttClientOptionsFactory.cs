using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using MQTTnet;
using MQTTnet.Formatter;

namespace MqttForge.Infrastructure.Mqtt;

// Turns a BrokerConnectionSettings into the options MQTTnet wants. Its own class because the
// mapping is the part of connecting that has rules worth testing on their own — which scheme a
// WebSocket URI gets, what a blank path means, which of six TLS fields is allowed to loosen
// validation — and none of that needs a broker to check.
public static class MqttClientOptionsFactory
{
    // MQTTnet defaults to pinging every 15 seconds and calls the link dead when a PINGRESP is
    // late. On a loaded public broker — with a '#' subscription filling the read loop — that is
    // no margin at all, and a working connection drops reporting "didn't respond in time".
    // A minute still notices a black-holed link quickly enough for a test tool, and a socket
    // that actually breaks is reported immediately either way; this only covers silent stalls.
    public static readonly TimeSpan KeepAlive = TimeSpan.FromSeconds(60);

    // The ladder Auto walks, newest first. Ordered by preference rather than by number: 5.0 is
    // what the console can say the most about, and 3.1 exists for the handful of brokers that
    // never moved on.
    public static readonly IReadOnlyList<MqttProtocolLevel> AutoLadder =
        [MqttProtocolLevel.V500, MqttProtocolLevel.V311, MqttProtocolLevel.V310];

    /// <summary>The versions an attempt will try, in order, for the level the reader chose.</summary>
    public static IReadOnlyList<MqttProtocolLevel> VersionsToTry(MqttProtocolLevel chosen) =>
        chosen == MqttProtocolLevel.Auto ? AutoLadder : [chosen];

    /// <param name="inspector">
    /// Watches the certificate callback. The verdict it returns is MQTTnet's own, so nothing
    /// that would have been refused is accepted; it is there to keep the reason, which the
    /// exception has already forgotten by the time it surfaces.
    /// </param>
    public static MqttClientOptions Build(
        BrokerConnectionSettings settings, MqttProtocolLevel version, TlsCertificateInspector inspector)
    {
        var builder = new MqttClientOptionsBuilder()
            .WithClientId(settings.ClientId)
            .WithProtocolVersion(Wire(version))
            .WithKeepAlivePeriod(KeepAlive)
            .WithCleanStart(settings.CleanSession);

        builder = settings.Transport == MqttTransport.WebSocket
            ? builder.WithWebSocketServer(ws => ws.WithUri(WebSocketUri(settings)))
            : builder.WithTcpServer(settings.Host, settings.Port);

        if (HasCredentials(settings))
            builder = builder.WithCredentials(settings.Username, settings.Password);

        // MQTT 5 only. On 3.x there is no such field, and MQTTnet's feature validation refuses
        // to build options carrying one — rightly, since the packet has nowhere to put it.
        if (version == MqttProtocolLevel.V500 && settings.SessionExpiryInterval is { } expiry)
            builder = builder.WithSessionExpiryInterval(expiry);

        if (settings.UseTls)
            builder = builder.WithTlsOptions(o => ConfigureTls(o, settings, inspector));

        return builder.Build();
    }

    /// <summary>Where a WebSocket connection is dialled, as MQTTnet wants it written.</summary>
    // MQTTnet takes a URI rather than a host and a port here, and it reads the scheme off that
    // URI to decide whether to wrap the socket in TLS — so the scheme, not the TLS options, is
    // what actually turns encryption on for a WebSocket. Getting that wrong produces a
    // connection that looks configured for TLS and is not, which is the worst shape a bug
    // about encryption can take.
    public static string WebSocketUri(BrokerConnectionSettings settings) =>
        $"{(settings.UseTls ? "wss" : "ws")}://{settings.Host}:{settings.Port}{settings.NormalisedWebSocketPath}";

    public static MqttProtocolVersion Wire(MqttProtocolLevel level) => level switch
    {
        MqttProtocolLevel.V310 => MqttProtocolVersion.V310,
        MqttProtocolLevel.V311 => MqttProtocolVersion.V311,
        MqttProtocolLevel.V500 => MqttProtocolVersion.V500,
        // Auto is an instruction, not a version. Nothing should reach here with it — VersionsToTry
        // expands it first — and answering with a guess would hide the caller that skipped that.
        _ => throw new ArgumentOutOfRangeException(
            nameof(level), level, "Auto is not a protocol version; expand it with VersionsToTry first.")
    };

    public static bool HasCredentials(BrokerConnectionSettings settings) =>
        !string.IsNullOrEmpty(settings.Username);

    private static void ConfigureTls(
        MqttClientTlsOptionsBuilder tls, BrokerConnectionSettings settings, TlsCertificateInspector inspector)
    {
        var extra = settings.TlsSettings;

        tls.UseTls()
            // MQTTnet asks for Online revocation, which is stricter than SslStream and
            // HttpClient both default to and stricter than a browser, which soft-fails. A
            // broker behind a private CA publishes no CRL and no OCSP responder, so the
            // chain comes back RevocationStatusUnknown and is refused however carefully the
            // CA was installed — which is to say every self-signed broker, the commonest
            // thing anyone points this at. Untrusted, expired and misnamed certificates are
            // still refused below; only "I could not ask whether it was revoked" stops
            // being fatal.
            .WithRevocationMode(X509RevocationMode.NoCheck);

        if (!string.IsNullOrWhiteSpace(extra.SniHost))
            tls.WithTargetHost(extra.SniHost);

        if (!string.IsNullOrWhiteSpace(extra.AlpnProtocol))
            tls.WithApplicationProtocols([new SslApplicationProtocol(extra.AlpnProtocol)]);

        // Our own certificate, for a broker that authenticates by certificate. A file we cannot
        // read is reported as itself rather than as a handshake that mysteriously failed.
        if (!string.IsNullOrWhiteSpace(extra.ClientCertificatePath))
            tls.WithClientCertificates([CertificateFiles.LoadClientCertificate(extra)]);

        // An extra root to verify against. Not a way round verification: the chain is still
        // built and still has to reach a root, this just adds one to the set of acceptable
        // roots. That is what makes it the honest answer to a private CA.
        var extraRoots = CertificateFiles.LoadAuthority(extra.CertificateAuthorityPath);

        if (extra.AllowUntrustedCertificates)
        {
            // The one setting that actually turns verification off. Both flags, because MQTTnet
            // consults them in different places and half of it is worse than neither: a reader
            // who ticked this and still could not connect would be debugging the wrong thing.
            tls.WithAllowUntrustedCertificates(true).WithIgnoreCertificateChainErrors(true);
            tls.WithCertificateValidationHandler(e =>
            {
                // Still watched, still recorded — a connection that only worked because the box
                // was ticked should be able to say what it overlooked.
                inspector.Overlook(e.SslPolicyErrors, e.Chain?.ChainStatus ?? []);
                return true;
            });
            return;
        }

        tls.WithCertificateValidationHandler(e =>
            inspector.Validate(e.SslPolicyErrors, e.Chain?.ChainStatus ?? [], e.Certificate, extraRoots));
    }
}
