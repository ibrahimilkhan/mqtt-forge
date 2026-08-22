using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using MqttForge.Domain.Enums;

namespace MqttForge.Infrastructure.Mqtt;

// A self-signed certificate, an expired one and one issued for another name all reach MQTTnet
// as the same AuthenticationException, with the reason already thrown away: .NET only emits its
// detailed wording when nobody supplied a validation callback, and MQTTnet always supplies one.
// So we watch from inside the callback, where the reason is still there.
//
// This OBSERVES, with two deliberate exceptions, both of which the reader asked for by filling
// in a field: a chain error gets a second chance against any extra CA they supplied, and
// Overlook accepts anything at all. Neither is reachable without one of those fields set.
public sealed class TlsCertificateInspector
{
    /// <summary>Why we refused the broker's certificate, or null when we did not refuse it.</summary>
    public BrokerFailureReason? Problem { get; private set; }

    /// <summary>
    /// What was wrong with a certificate we accepted anyway, because the reader ticked the box
    /// that says to. A connection that only worked for that reason should be able to say so.
    /// </summary>
    public BrokerFailureReason? Overlooked { get; private set; }

    public void Reset()
    {
        Problem = null;
        Overlooked = null;
    }

    public bool Validate(SslPolicyErrors errors, X509ChainStatus[] chainStatus) =>
        Validate(errors, chainStatus, certificate: null, extraRoots: null);

    public bool Validate(
        SslPolicyErrors errors,
        X509ChainStatus[] chainStatus,
        X509Certificate? certificate,
        X509Certificate2Collection? extraRoots)
    {
        if (errors == SslPolicyErrors.None)
        {
            Problem = null;
            return true;
        }

        // Only the chain, and only when a root was actually supplied. A name mismatch is not a
        // trust question and no CA file fixes it; a missing certificate leaves nothing to build
        // a chain from. Both keep failing here, which is what makes this narrow enough to be safe.
        if (errors == SslPolicyErrors.RemoteCertificateChainErrors
            && extraRoots is { Count: > 0 }
            && certificate is not null
            && ChainsTo(certificate, extraRoots))
        {
            Problem = null;
            return true;
        }

        Problem = Describe(errors, chainStatus);

        return false;
    }

    /// <summary>Accept whatever was presented, and write down what was wrong with it.</summary>
    // Deliberately does not set Problem: nothing was refused here, and a handshake that fails
    // after this point failed for a reason of its own, which the manager needs to be able to
    // tell apart from a certificate we objected to.
    public void Overlook(SslPolicyErrors errors, X509ChainStatus[] chainStatus)
    {
        Problem = null;
        Overlooked = Describe(errors, chainStatus);
    }

    public static BrokerFailureReason? Describe(SslPolicyErrors errors, X509ChainStatus[] chainStatus)
    {
        if (errors == SslPolicyErrors.None) return null;

        // Checked first: a name mismatch is the one problem the user fixes by retyping the host
        if (errors.HasFlag(SslPolicyErrors.RemoteCertificateNameMismatch))
            return BrokerFailureReason.TlsCertNameMismatch;

        // Before the untrusted case, because an expired certificate also fails to chain
        if (chainStatus.Any(s => s.Status.HasFlag(X509ChainStatusFlags.NotTimeValid)))
            return BrokerFailureReason.TlsCertExpired;

        return BrokerFailureReason.TlsCertUntrusted;
    }

    // Rebuilt against the supplied roots ALONE, which is what CustomRootTrust means. The system
    // store has already had its turn — that is what produced the chain error we are here about —
    // so nothing is being widened twice, and a certificate that reaches neither is still refused.
    private static bool ChainsTo(X509Certificate certificate, X509Certificate2Collection roots)
    {
        using var chain = new X509Chain();
        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        chain.ChainPolicy.CustomTrustStore.AddRange(roots);

        // Same reasoning as the connection's own revocation mode: a private CA publishes no
        // responder to ask. Expiry and the chain itself are still checked, by default.
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;

        // Intermediates the broker sent alongside its own certificate travel in the collection
        // the caller supplied; anything else has to be in the CA file, which is where a reader
        // pointed at "the certificate that signed my broker" would put it anyway.
        using var subject = X509CertificateLoader.LoadCertificate(certificate.GetRawCertData());

        return chain.Build(subject);
    }
}
