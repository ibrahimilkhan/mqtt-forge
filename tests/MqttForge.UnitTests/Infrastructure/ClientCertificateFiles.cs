using System.Diagnostics;
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

    // Every load of one of these files is a temporary keychain in $TMPDIR on macOS, and two tests
    // count the keychains of this certificate there. The tests that load them share this collection,
    // so that none of them is loading while one of those counts.
    public const string Collection = "client certificate files";

    public ClientCertificateFiles()
    {
        Directory = System.IO.Directory.CreateTempSubdirectory("mqttforge-client-certificate-").FullName;

        // A name of its own for every run, so a keychain in $TMPDIR can be told for this run's by the
        // certificate in it: see KeychainsSince.
        CommonName = $"mqttforge-client-{Guid.NewGuid():N}";

        using var key = RSA.Create(2048);
        var request = new CertificateRequest(
            $"CN={CommonName}", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
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

    /// <summary>The certificate's subject, CN=this: mqttforge-client and a new GUID for every run.</summary>
    public string CommonName { get; }

    public string Pfx => Path.Combine(Directory, "client.pfx");
    public string PemCertificate => Path.Combine(Directory, "client.crt");
    public string PemKey => Path.Combine(Directory, "client.key");

    /// <summary>The temporary keychains in $TMPDIR, by name, whoever made them: the list a test is measured against.</summary>
    public static HashSet<string> Keychains() =>
        System.IO.Directory.EnumerateFiles(Path.GetTempPath(), "*.keychain").Select(Path.GetFileName).ToHashSet()!;

    /// <summary>
    /// The temporary keychains in $TMPDIR that were not there <paramref name="before"/> and hold this
    /// certificate: macOS's trace of it loaded with its key and not let go.
    /// </summary>
    // Only this certificate's. $TMPDIR is shared with every other process's keychains: `dotnet test`
    // at the root runs the integration suite beside this one, whose TLS fixtures make a keychain for
    // every certificate they create and every mTLS link they dial, and a run in another worktree
    // makes keychains of a client certificate of its own. Counted whole, a keychain any of them made
    // while a test was counting was taken for that test's leak.
    public IReadOnlyList<string> KeychainsSince(HashSet<string> before) =>
        [.. Keychains().Except(before).Where(Holds).Order(StringComparer.Ordinal)];

    // Asked of macOS's own tool: `security find-certificate -c <name> <keychain>` answers 0 when the
    // keychain holds a certificate whose name has <name> in it, and 44 when it holds none — or when it
    // was deleted after the listing, which is a keychain nobody left behind either.
    private bool Holds(string keychain)
    {
        var ask = new ProcessStartInfo("/usr/bin/security")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        ask.ArgumentList.Add("find-certificate");
        ask.ArgumentList.Add("-c");
        ask.ArgumentList.Add(CommonName);
        ask.ArgumentList.Add(Path.Combine(Path.GetTempPath(), keychain));

        using var security = Process.Start(ask)!;

        // What it prints is not wanted, only read, so neither pipe can fill and hold the tool up.
        security.OutputDataReceived += (_, _) => { };
        security.ErrorDataReceived += (_, _) => { };
        security.BeginOutputReadLine();
        security.BeginErrorReadLine();
        security.WaitForExit();

        return security.ExitCode == 0;
    }

    public void Dispose() => System.IO.Directory.Delete(Directory, recursive: true);
}

[CollectionDefinition(ClientCertificateFiles.Collection)]
public sealed class ClientCertificateFilesCollection : ICollectionFixture<ClientCertificateFiles>;
