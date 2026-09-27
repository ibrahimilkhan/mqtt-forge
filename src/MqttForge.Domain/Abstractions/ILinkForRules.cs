namespace MqttForge.Domain.Abstractions;

/// <summary>Asks for a broker link on behalf of the alert rules and the flows.</summary>
// A host that dials because a rule wants one does it at start-up, and only then: a container
// started with no rules and given one an hour later had nobody to notice. Nothing was watched,
// nothing was said, and the only trace was an alerts panel nobody had a browser open to read.
//
// Its own interface rather than a method on the supervisor, because its callers, AlertRuleService
// and FlowService, are in Application and the supervisor is in Api — and because only a host that
// dials at start-up may do this. A desktop console must not connect because somebody saved a rule
// or a flow; that reader has a Connect button and did not press it. The name is the rules', which
// asked first; a flow asks for the same thing.
public interface ILinkForRules
{
    /// <summary>A rule or a flow now wants a link. Dials if this host is one that dials at start-up.</summary>
    Task WantedAsync(CancellationToken ct);
}
