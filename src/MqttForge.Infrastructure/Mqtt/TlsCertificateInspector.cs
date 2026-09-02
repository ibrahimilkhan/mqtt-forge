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
    /// Whether the broker got as far as presenting a certificate.
    /// </summary>
    /// <remarks>
    /// Proof that whatever is on that port speaks TLS, which is a different question from whether
    /// the handshake then succeeded — and the only way to tell the two failures apart on a
    /// platform that words them the same. See the manager's Explain.
    /// </remarks>
    public bool Answered { get; private set; }

    /// <summary>
    /// What was wrong with a certificate we accepted anyway, because the reader ticked the box
    /// that says to. A connection that only worked for that reason should be able to say so.
    /// </summary>
    public BrokerFailureReason? Overlooked { get; private set; }

    public void Reset()
    {
        Problem = null;
        Overlooked = null;
        Answered = false;
    }

    public bool Validate(SslPolicyErrors errors, X509ChainStatus[] chainStatus) =>
        Validate(errors, chainStatus, certificate: null, extraRoots: null);

    public bool Validate(
        SslPolicyErrors errors,
        X509ChainStatus[] chainStatus,
        X509Certificate? certificate,
        X509Certificate2Collection? extraRoots)
    {
        // Set before anything is decided, and never unset: whether we go on to accept or refuse
        // the certificate, being asked about one at all is the fact this records.
        Answered = true;

        if (errors == SslPolicyErrors.None)
        {
            Problem = null;
            return true;
        }

        // Whether the chain is one this connection trusts — either the machine's store said so,
        // or the extra CA the reader pointed at signs it. Worked out first, because everything
        // said below depends on it: a name mismatch on a certificate nobody trusts is not the
        // news, and a reader told to set Server name on a self-signed certificate would set it
        // and be refused again. A missing certificate leaves nothing to build a chain from, so it
        // never counts as trusted whatever roots were supplied.
        var chainTrusted = !errors.HasFlag(SslPolicyErrors.RemoteCertificateChainErrors)
            && !errors.HasFlag(SslPolicyErrors.RemoteCertificateNotAvailable);

        if (!chainTrusted
            && !errors.HasFlag(SslPolicyErrors.RemoteCertificateNotAvailable)
            && extraRoots is { Count: > 0 }
            && certificate is not null
            && ChainsTo(certificate, extraRoots))
        {
            chainTrusted = true;
        }

        // A trusted chain with the right name is a certificate with nothing wrong with it; the
        // name is the one thing a CA file cannot vouch for, so it still fails here on its own.
        if (chainTrusted && !errors.HasFlag(SslPolicyErrors.RemoteCertificateNameMismatch))
        {
            Problem = null;
            return true;
        }

        Problem = Describe(errors, chainStatus, chainTrusted);

        return false;
    }

    /// <summary>Accept whatever was presented, and write down what was wrong with it.</summary>
    // Deliberately does not set Problem: nothing was refused here, and a handshake that fails
    // after this point failed for a reason of its own, which the manager needs to be able to
    // tell apart from a certificate we objected to.
    public void Overlook(SslPolicyErrors errors, X509ChainStatus[] chainStatus)
    {
        Answered = true;
        Problem = null;
        Overlooked = Describe(errors, chainStatus);
    }

    // Read off the errors alone, for callers that have no extra roots to vouch with.
    public static BrokerFailureReason? Describe(SslPolicyErrors errors, X509ChainStatus[] chainStatus) =>
        Describe(
            errors, chainStatus,
            chainTrusted: !errors.HasFlag(SslPolicyErrors.RemoteCertificateChainErrors)
                && !errors.HasFlag(SslPolicyErrors.RemoteCertificateNotAvailable));

    // The chain first, and the name only once the chain is good. It was the other way round —
    // the name being "the one problem the user fixes by retyping the host" — and EMQX's own
    // self-signed certificate, untrusted and issued for a name nothing dials it by, was reported
    // as the name being wrong, which sent the reader to a Server name box that could not have
    // helped. Expiry within an untrusted chain still outranks 'untrusted': it is the more specific
    // of the two things the chain is wrong about, and an expired certificate also fails to chain.
    public static BrokerFailureReason? Describe(
        SslPolicyErrors errors, X509ChainStatus[] chainStatus, bool chainTrusted)
    {
        if (errors == SslPolicyErrors.None) return null;

        if (!chainTrusted)
        {
            if (chainStatus.Any(s => s.Status.HasFlag(X509ChainStatusFlags.NotTimeValid)))
                return BrokerFailureReason.TlsCertExpired;

            return BrokerFailureReason.TlsCertUntrusted;
        }

        if (errors.HasFlag(SslPolicyErrors.RemoteCertificateNameMismatch))
            return BrokerFailureReason.TlsCertNameMismatch;

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
