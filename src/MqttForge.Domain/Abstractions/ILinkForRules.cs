namespace MqttForge.Domain.Abstractions;

/// <summary>Asks for a broker link on behalf of the alert rules.</summary>
// A host that dials because a rule wants one does it at start-up, and only then: a container
// started with no rules and given one an hour later had nobody to notice. Nothing was watched,
// nothing was said, and the only trace was an alerts panel nobody had a browser open to read.
//
// Its own interface rather than a method on the supervisor, because the caller is
// AlertRuleService in Application and the supervisor is in Api — and because only a host that
// dials at start-up may do this. A desktop console must not connect because somebody saved a
// rule; that reader has a Connect button and did not press it.
public interface ILinkForRules
{
    /// <summary>A rule now wants a link. Dials if this host is one that dials for rules.</summary>
    Task WantedAsync(CancellationToken ct);
}
