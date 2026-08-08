using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using MQFaker.Domain.Enums;
using MQFaker.Infrastructure.Mqtt;
using Xunit;

namespace MQFaker.UnitTests.Infrastructure;

// Every certificate problem reaches MQTTnet as the same AuthenticationException, with no chain
// status and no policy errors left on it. Catching them where .NET still knows is the only way.
public class TlsCertificateInspectorTests
{
    [Fact]
    public void A_name_that_does_not_match_the_certificate_is_named_as_such()
    {
        Assert.Equal(
            BrokerFailureReason.TlsCertNameMismatch,
            TlsCertificateInspector.Describe(SslPolicyErrors.RemoteCertificateNameMismatch, []));
    }

    [Fact]
    public void An_expired_certificate_is_told_apart_from_an_untrusted_one()
    {
        Assert.Equal(
            BrokerFailureReason.TlsCertExpired,
            TlsCertificateInspector.Describe(
                SslPolicyErrors.RemoteCertificateChainErrors, [Status(X509ChainStatusFlags.NotTimeValid)]));
    }

    [Theory]
    [InlineData(X509ChainStatusFlags.UntrustedRoot)]
    [InlineData(X509ChainStatusFlags.PartialChain)]
    [InlineData(X509ChainStatusFlags.RevocationStatusUnknown)]
    public void A_chain_that_does_not_lead_to_a_trusted_root_is_named_as_such(X509ChainStatusFlags flag)
    {
        Assert.Equal(
            BrokerFailureReason.TlsCertUntrusted,
            TlsCertificateInspector.Describe(SslPolicyErrors.RemoteCertificateChainErrors, [Status(flag)]));
    }

    [Fact]
    public void A_peer_that_offered_no_certificate_at_all_counts_as_untrusted()
    {
        Assert.Equal(
            BrokerFailureReason.TlsCertUntrusted,
            TlsCertificateInspector.Describe(SslPolicyErrors.RemoteCertificateNotAvailable, []));
    }

    // Expiry is the more actionable of the two, so it wins when both are reported.
    [Fact]
    public void Expiry_outranks_an_untrusted_root()
    {
        Assert.Equal(
            BrokerFailureReason.TlsCertExpired,
            TlsCertificateInspector.Describe(
                SslPolicyErrors.RemoteCertificateChainErrors,
                [Status(X509ChainStatusFlags.UntrustedRoot), Status(X509ChainStatusFlags.NotTimeValid)]));
    }

    [Fact]
    public void A_certificate_with_no_problems_leaves_nothing_to_report()
    {
        Assert.Null(TlsCertificateInspector.Describe(SslPolicyErrors.None, []));
    }

    // The inspector watches; it must never widen what .NET would have accepted.
    [Fact]
    public void Validating_gives_the_same_verdict_dotnet_would_have()
    {
        var inspector = new TlsCertificateInspector();

        Assert.False(inspector.Validate(SslPolicyErrors.RemoteCertificateNameMismatch, []));
        Assert.Equal(BrokerFailureReason.TlsCertNameMismatch, inspector.Problem);

        Assert.True(inspector.Validate(SslPolicyErrors.None, []));
        Assert.Null(inspector.Problem);
    }

    private static X509ChainStatus Status(X509ChainStatusFlags flag) => new() { Status = flag };
}
