using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Mqtt;
using Xunit;

namespace MqttForge.UnitTests.Infrastructure;

// What loading a client certificate leaves behind once the certificate it hands back is let go.
//
// Only macOS shows it: there a certificate loaded with its key lives in a temporary keychain in
// $TMPDIR, <guid>.keychain, deleted when the certificate is disposed. Elsewhere the same leak holds
// memory, or on Windows a key in the user's store, and there is no file to look for.
[Collection(ClientCertificateFiles.Collection)]
public sealed class CertificateFilesTests(ClientCertificateFiles files)
{
    // A PEM pair is loaded twice over: from the files, and then through PKCS#12, because SslStream
    // on Windows will not use a key that came from a PEM as it stands. The first of the two was
    // never disposed.
    [Fact]
    public void A_PEM_pair_leaves_no_keychain_behind_once_its_certificate_is_let_go()
    {
        if (!OperatingSystem.IsMacOS()) return;

        var before = ClientCertificateFiles.Keychains();

        CertificateFiles.LoadClientCertificate(
            new BrokerTlsSettings(ClientCertificatePath: files.PemCertificate, ClientCertificateKeyPath: files.PemKey))
            .Dispose();

        Assert.Empty(ClientCertificateFiles.Keychains().Except(before));
    }

    [Fact]
    public void A_pfx_leaves_no_keychain_behind_once_its_certificate_is_let_go()
    {
        if (!OperatingSystem.IsMacOS()) return;

        var before = ClientCertificateFiles.Keychains();

        CertificateFiles.LoadClientCertificate(
            new BrokerTlsSettings(ClientCertificatePath: files.Pfx, ClientCertificatePassword: ClientCertificateFiles.Password))
            .Dispose();

        Assert.Empty(ClientCertificateFiles.Keychains().Except(before));
    }
}
