namespace MqttForge.Domain.Models;

// Everything about the encrypted channel beyond "use one". All of it is optional and all of it
// is off by default, because the console's strict validation is the behaviour that protects a
// reader who never opens this section — it is the brokers that cannot be reached without one of
// these that the section exists for.
//
// Files are named by path rather than uploaded: the connection is held by the server, so the
// certificate has to be readable where the server runs, and a path is the only thing that means
// the same on a desktop app and in a container with a mounted volume.
public sealed record BrokerTlsSettings(
    // Accept whatever certificate the broker presents. A development broker with a self-signed
    // certificate and no CA to hand — nothing else. Named the way it is so a reader ticking it
    // knows what they are giving up.
    bool AllowUntrustedCertificates = false,

    // A CA to trust in addition to the machine's own store, as PEM or DER. The honest answer to
    // a private CA: the chain is still verified, just against a root you supplied.
    string? CertificateAuthorityPath = null,

    // Our own certificate, for a broker that authenticates clients by certificate rather than
    // by password — AWS IoT Core's only method, and how most industrial brokers are locked down.
    // PKCS#12 (.pfx/.p12) carries its key inside; a PEM pair is loaded as certificate + key.
    string? ClientCertificatePath = null,
    string? ClientCertificateKeyPath = null,

    // Saved alongside the rest, the same way the broker password already is, and returned to
    // the console the same way too: never. What comes back is whether there is one.
    string? ClientCertificatePassword = null,

    // The name to offer in the TLS handshake, when it is not the host being dialled. A broker
    // behind a load balancer reached by IP needs this, and so does anything routed by SNI.
    string? SniHost = null,

    // The application protocol to negotiate. AWS IoT Core requires x-amzn-mqtt-ca to accept MQTT
    // on port 443, which is the only way through a firewall that allows nothing else.
    string? AlpnProtocol = null)
{
    // The all-defaults instance, so callers can ask "was anything set here" in one comparison
    // rather than testing six fields.
    public static readonly BrokerTlsSettings None = new();

    public bool IsDefault => this == None;
}
