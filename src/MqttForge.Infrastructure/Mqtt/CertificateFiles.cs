using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using MqttForge.Domain.Models;

namespace MqttForge.Infrastructure.Mqtt;

// Reads the certificate files a connection was pointed at. Its own class because the failure
// modes are all about the file — missing, wrong password, not a certificate — and none of them
// should reach the reader dressed up as a handshake that went wrong for unknowable reasons.
public static class CertificateFiles
{
    /// <summary>Our own certificate, for a broker that authenticates clients by certificate.</summary>
    public static X509Certificate2 LoadClientCertificate(BrokerTlsSettings settings)
    {
        var path = settings.ClientCertificatePath!;
        var key = settings.ClientCertificateKeyPath;
        var password = settings.ClientCertificatePassword;

        if (!File.Exists(path))
            throw new CertificateFileException($"No certificate file at {path}.");

        if (key is { Length: > 0 } && !File.Exists(key))
            throw new CertificateFileException($"No private key file at {key}.");

        try
        {
            var loaded = IsPkcs12(path)
                ? X509CertificateLoader.LoadPkcs12FromFile(path, password)
                : FromPem(path, key, password);

            // A certificate whose key came from a PEM cannot be used for a TLS handshake as it
            // stands on Windows — the key is ephemeral and SslStream will not touch it. Round
            // -tripping through PKCS#12 attaches it properly, and costs nothing anywhere else.
            return IsPkcs12(path)
                ? loaded
                : X509CertificateLoader.LoadPkcs12(loaded.Export(X509ContentType.Pkcs12), null);
        }
        catch (Exception ex) when (ex is CryptographicException or IOException or UnauthorizedAccessException)
        {
            // Nearly always the password, and saying so first saves the reader checking the path
            // they can see is right. The library's own wording follows it.
            throw new CertificateFileException(
                $"Could not read the client certificate at {path} — check the password and the file's format. {ex.Message}", ex);
        }
    }

    /// <summary>
    /// Extra roots to accept, on top of the machine's own store. Empty when no file was named,
    /// which is the ordinary case.
    /// </summary>
    public static X509Certificate2Collection LoadAuthority(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return [];

        if (!File.Exists(path))
            throw new CertificateFileException($"No CA certificate file at {path}.");

        var collection = new X509Certificate2Collection();

        try
        {
            // A PEM bundle may hold a whole chain, and a broker behind an intermediate needs all
            // of it. ImportFromPemFile takes every certificate in the file; DER holds one.
            if (IsPem(path)) collection.ImportFromPemFile(path);
            else collection.Add(X509CertificateLoader.LoadCertificateFromFile(path));
        }
        catch (Exception ex) when (ex is CryptographicException or IOException or UnauthorizedAccessException)
        {
            throw new CertificateFileException(
                $"Could not read the CA certificate at {path} — it is not a PEM or DER certificate. {ex.Message}", ex);
        }

        if (collection.Count == 0)
            throw new CertificateFileException($"The file at {path} holds no certificate.");

        return collection;
    }

    private static X509Certificate2 FromPem(string path, string? keyPath, string? password) =>
        keyPath is { Length: > 0 }
            ? Pair(path, keyPath, password)
            // No key file named, so the key is expected inside the same PEM — the shape most
            // tools export when they are asked for "the certificate and its key".
            : Pair(path, path, password);

    private static X509Certificate2 Pair(string certPath, string keyPath, string? password) =>
        string.IsNullOrEmpty(password)
            ? X509Certificate2.CreateFromPemFile(certPath, keyPath)
            : X509Certificate2.CreateFromEncryptedPemFile(certPath, password, keyPath);

    // By extension, because that is all there is to go on before opening the file, and every
    // tool that writes one of these uses these names.
    private static bool IsPkcs12(string path) =>
        Path.GetExtension(path).ToLowerInvariant() is ".pfx" or ".p12";

    private static bool IsPem(string path) =>
        Path.GetExtension(path).ToLowerInvariant() is ".pem" or ".crt" or ".cer" or ".ca" or ".chain" or "";
}

// A file we were pointed at and could not use. Separate from every other connect failure
// because nothing on the network has happened yet: the fix is on this machine.
public sealed class CertificateFileException : Exception
{
    public CertificateFileException(string message, Exception? inner = null) : base(message, inner) { }
}
