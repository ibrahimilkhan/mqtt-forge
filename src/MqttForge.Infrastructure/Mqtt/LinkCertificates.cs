using System.Security.Cryptography.X509Certificates;

namespace MqttForge.Infrastructure.Mqtt;

/// <summary>
/// The certificates read from files for one attempt at a broker: our own, and any extra roots.
/// The attempt's until the broker takes its CONNECT, then the link's until the link is over.
/// </summary>
// Nothing used to dispose them, and a certificate loaded with its key is more than memory: on
// macOS a temporary keychain in $TMPDIR, on Windows a key written into the user's store, each kept
// until Dispose or the finalizer, and the end of a process waits for neither. Every attempt loads
// its own, so a supervisor redialling a broker that had gone away left one behind on every rung.
//
// Kept for the whole link, not only the handshake. MQTTnet allows renegotiation, and a broker that
// asks for our certificate again in the middle of a session is asking SslStream for this one; the
// roots answer the same question about the broker's. Once the link is over nothing asks: MQTTnet
// reads the options again only to dial with them again, which its ReconnectAsync would do and
// nothing here calls, because every dial builds its own.
public sealed class LinkCertificates : IDisposable
{
    private List<X509Certificate2> _held = [];

    /// <summary>Holds <paramref name="certificate"/>, to be disposed of with the rest, and hands it back.</summary>
    public X509Certificate2 Hold(X509Certificate2 certificate)
    {
        _held.Add(certificate);
        return certificate;
    }

    /// <summary>Holds every certificate in <paramref name="certificates"/>, and hands the collection back.</summary>
    public X509Certificate2Collection Hold(X509Certificate2Collection certificates)
    {
        _held.AddRange(certificates);
        return certificates;
    }

    /// <summary>Everything held, in a holder of its own. This one is left holding nothing.</summary>
    // How an attempt gives the link it made what it loaded, from inside the using that lets them go
    // when the attempt ends any other way.
    public LinkCertificates HandOver()
    {
        var handed = new LinkCertificates { _held = _held };
        _held = [];
        return handed;
    }

    public void Dispose()
    {
        foreach (var certificate in _held) certificate.Dispose();
        _held = [];
    }
}
