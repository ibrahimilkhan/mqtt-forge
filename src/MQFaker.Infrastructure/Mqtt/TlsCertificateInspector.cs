using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using MQFaker.Domain.Enums;

namespace MQFaker.Infrastructure.Mqtt;

// A self-signed certificate, an expired one and one issued for another name all reach MQTTnet
// as the same AuthenticationException, with the reason already thrown away: .NET only emits its
// detailed wording when nobody supplied a validation callback, and MQTTnet always supplies one.
// So we watch from inside the callback, where the reason is still there.
//
// This OBSERVES. The verdict it returns is the one MQTTnet's own default gives, so nothing that
// would have been refused is accepted.
public sealed class TlsCertificateInspector
{
    public BrokerFailureReason? Problem { get; private set; }

    public void Reset() => Problem = null;

    public bool Validate(SslPolicyErrors errors, X509ChainStatus[] chainStatus)
    {
        Problem = Describe(errors, chainStatus);

        return errors == SslPolicyErrors.None;
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
}
