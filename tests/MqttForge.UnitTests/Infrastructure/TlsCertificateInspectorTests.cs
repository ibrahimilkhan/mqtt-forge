using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using MqttForge.Domain.Enums;
using MqttForge.Infrastructure.Mqtt;
using Xunit;

namespace MqttForge.UnitTests.Infrastructure;

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

    /// <summary>
    /// The fact that separates a broker refusing our client certificate from a port that does not
    /// speak TLS at all.
    /// </summary>
    // Both arrive as a bare IOException on Linux, and nothing in the exception tells them apart.
    // How far the handshake got does: a broker that presented a certificate speaks TLS, whatever
    // it went on to do about ours.
    [Fact]
    public void Nothing_is_answered_until_a_certificate_has_been_seen()
    {
        var inspector = new TlsCertificateInspector();

        Assert.False(inspector.Answered);

        inspector.Validate(SslPolicyErrors.None, []);

        Assert.True(inspector.Answered);
    }

    // A certificate we refused is still a certificate we were shown.
    [Fact]
    public void A_refused_certificate_was_answered_all_the_same()
    {
        var inspector = new TlsCertificateInspector();

        inspector.Validate(SslPolicyErrors.RemoteCertificateNameMismatch, []);

        Assert.True(inspector.Answered);
    }

    // And so is one the reader told us to accept anyway.
    [Fact]
    public void An_overlooked_certificate_was_answered_too()
    {
        var inspector = new TlsCertificateInspector();

        inspector.Overlook(SslPolicyErrors.RemoteCertificateChainErrors, []);

        Assert.True(inspector.Answered);
    }

    // One inspector serves every attempt on the ladder, so what the last one saw must not be
    // read as what this one is seeing.
    [Fact]
    public void A_reset_forgets_that_anything_answered()
    {
        var inspector = new TlsCertificateInspector();

        inspector.Validate(SslPolicyErrors.None, []);
        inspector.Reset();

        Assert.False(inspector.Answered);
    }

    private static X509ChainStatus Status(X509ChainStatusFlags flag) => new() { Status = flag };
}
