using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace MqttForge.IntegrationTests.Support;

// A throwaway CA and the certificates it signs, written to a temp directory for a broker
// container to mount and for the console to be pointed at.
//
// Generated here rather than committed, and generated in .NET rather than by shelling out to
// openssl: a key in a repository is a key anybody can sign with, and macOS ships LibreSSL, which
// refuses half of what generating these takes. Everything lives for the length of one test run.
public sealed class TestCertificates : IDisposable
{
    // One clock reading for the whole set. Taken once because .NET refuses to issue a
    // certificate that outlives its issuer, and reading UtcNow again for each one put a leaf a
    // second past the CA it was signed by — which failed roughly one run in three, and only
    // when the two calls happened to land either side of a tick.
    private static readonly DateTimeOffset From = DateTimeOffset.UtcNow.AddDays(-1);

    // A year of headroom over anything it signs, so the same thing cannot happen again by a
    // narrower margin.
    private static readonly DateTimeOffset AuthorityUntil = From.AddYears(2);
    private static readonly DateTimeOffset LeafUntil = From.AddYears(1);

    private readonly List<X509Certificate2> _issued = [];
    private readonly X509Certificate2 _authority;

    public TestCertificates(string? subjectAlternativeName = null)
    {
        Directory = System.IO.Directory.CreateTempSubdirectory("mqttforge-certs-").FullName;

        // World-readable, because mosquitto drops to its own user inside the container and a
        // 0700 directory owned by whoever ran the tests is one it cannot read. Nothing to do on
        // Windows, where a bind mount carries no Unix mode in the first place.
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(Directory,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute |
                UnixFileMode.GroupRead | UnixFileMode.GroupExecute |
                UnixFileMode.OtherRead | UnixFileMode.OtherExecute);

        _authority = CreateAuthority();
        Write("ca.crt", _authority.ExportCertificatePem());

        var server = CreateSigned("localhost", authentication: "1.3.6.1.5.5.7.3.1", subjectAlternativeName);
        Write("server.crt", server.ExportCertificatePem());
        Write("server.key", server.GetRSAPrivateKey()!.ExportPkcs8PrivateKeyPem());

        var client = CreateSigned("mqttforge-client", authentication: "1.3.6.1.5.5.7.3.2");
        Write("client.crt", client.ExportCertificatePem());
        Write("client.key", client.GetRSAPrivateKey()!.ExportPkcs8PrivateKeyPem());
        File.WriteAllBytes(Path.Combine(Directory, "client.pfx"), client.Export(X509ContentType.Pkcs12, ClientPassword));

        // Correctly formed, signed by nobody the broker knows. What a rejected client
        // certificate looks like, as against one that was never sent.
        using var stranger = SelfSigned("stranger");
        File.WriteAllBytes(Path.Combine(Directory, "stranger.pfx"), stranger.Export(X509ContentType.Pkcs12));
    }

    public const string ClientPassword = "forge";

    public string Directory { get; }

    public string AuthorityPath => Path.Combine(Directory, "ca.crt");
    public string ClientCertificatePath => Path.Combine(Directory, "client.pfx");
    public string ClientPemPath => Path.Combine(Directory, "client.crt");
    public string ClientKeyPath => Path.Combine(Directory, "client.key");
    public string StrangerPath => Path.Combine(Directory, "stranger.pfx");

    public void Dispose()
    {
        foreach (var certificate in _issued) certificate.Dispose();
        _authority.Dispose();

        try
        {
            System.IO.Directory.Delete(Directory, recursive: true);
        }
        catch (IOException)
        {
            // A temp directory left behind is not worth failing a test run over.
        }
    }

    private void Write(string name, string contents) =>
        File.WriteAllText(Path.Combine(Directory, name), contents);

    private static X509Certificate2 CreateAuthority()
    {
        using var key = RSA.Create(2048);
        var request = new CertificateRequest(
            "CN=MQTTForge Test CA", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);

        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        request.CertificateExtensions.Add(
            new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign, true));

        return request.CreateSelfSigned(From, AuthorityUntil);
    }

    // Signed by the CA above, so a client that has been handed ca.crt can build a chain to it
    // and one that has not cannot — which is the whole of what these fixtures are for.
    private X509Certificate2 CreateSigned(string commonName, string authentication, string? sanOverride = null)
    {
        var key = RSA.Create(2048);
        var request = new CertificateRequest(
            $"CN={commonName}", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);

        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension([new Oid(authentication)], false));

        var names = new SubjectAlternativeNameBuilder();
        if (sanOverride is not null)
        {
            names.AddDnsName(sanOverride);
        }
        else
        {
            names.AddDnsName("localhost");
            names.AddIpAddress(System.Net.IPAddress.Loopback);
            // Testcontainers reports the host as localhost on Linux and as 127.0.0.1 elsewhere,
            // and Docker Desktop uses this one; all three have to validate or the test is
            // measuring the certificate's names rather than the code under test.
            names.AddDnsName("host.docker.internal");
        }

        request.CertificateExtensions.Add(names.Build());

        var signed = request.Create(_authority, From, LeafUntil, Guid.NewGuid().ToByteArray());

        // Create() returns the certificate without its private key attached; the two have to be
        // put back together before anything can be exported or used for a handshake.
        var withKey = signed.CopyWithPrivateKey(key);
        signed.Dispose();
        _issued.Add(withKey);

        return withKey;
    }

    private static X509Certificate2 SelfSigned(string commonName)
    {
        using var key = RSA.Create(2048);
        var request = new CertificateRequest(
            $"CN={commonName}", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);

        request.CertificateExtensions.Add(
            new X509EnhancedKeyUsageExtension([new Oid("1.3.6.1.5.5.7.3.2")], false));

        return request.CreateSelfSigned(From, LeafUntil);
    }
}
