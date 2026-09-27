using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Xunit;

namespace MqttForge.UnitTests.Infrastructure;

// A client certificate with its key, written the two ways the console can be pointed at one: a
// PKCS#12 with a password, and a PEM certificate with its key in a file beside it. Made here rather
// than committed, because a key in a repository is a key anybody can sign with, and in a folder of
// its own that goes when the tests are done.
public sealed class ClientCertificateFiles : IDisposable
{
    public const string Password = "forge";

    // Every load of one of these files is a temporary keychain in $TMPDIR on macOS, and one test
    // counts the keychains there. The tests that load them share this collection, so that none of
    // them is loading while that one counts.
    public const string Collection = "client certificate files";

    public ClientCertificateFiles()
    {
        Directory = System.IO.Directory.CreateTempSubdirectory("mqttforge-client-certificate-").FullName;

        using var key = RSA.Create(2048);
        var request = new CertificateRequest(
            "CN=mqttforge-client", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        request.CertificateExtensions.Add(
            new X509EnhancedKeyUsageExtension([new Oid("1.3.6.1.5.5.7.3.2")], false));

        using var certificate = request.CreateSelfSigned(
            DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddYears(1));

        File.WriteAllBytes(Pfx, certificate.Export(X509ContentType.Pkcs12, Password));
        File.WriteAllText(PemCertificate, certificate.ExportCertificatePem());

        // The key made above, and not the certificate's copy of it: on macOS that copy lives in the
        // certificate's keychain and keeps it open for as long as nobody disposes it.
        File.WriteAllText(PemKey, key.ExportPkcs8PrivateKeyPem());
    }

    public string Directory { get; }

    public string Pfx => Path.Combine(Directory, "client.pfx");
    public string PemCertificate => Path.Combine(Directory, "client.crt");
    public string PemKey => Path.Combine(Directory, "client.key");

    /// <summary>The temporary keychains in $TMPDIR, by name: macOS's trace of a certificate loaded with its key.</summary>
    public static HashSet<string> Keychains() =>
        System.IO.Directory.EnumerateFiles(Path.GetTempPath(), "*.keychain").Select(Path.GetFileName).ToHashSet()!;

    public void Dispose() => System.IO.Directory.Delete(Directory, recursive: true);
}

[CollectionDefinition(ClientCertificateFiles.Collection)]
public sealed class ClientCertificateFilesCollection : ICollectionFixture<ClientCertificateFiles>;
