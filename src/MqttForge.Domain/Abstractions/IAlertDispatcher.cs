using MqttForge.Domain.Models;

namespace MqttForge.Domain.Abstractions;

/// <summary>The alert channels that leave the process.</summary>
// Beside IAlertNotifier and deliberately not folded into it. screen and sound are the console's
// own business — instant, in-process, and delivered for every alert there is — and they go
// through the notifier. A webhook and a publish are neither instant nor local: one is a POST that
// may take ten seconds and be retried twice, the other needs a broker link that may be down. An
// interface that carried both kinds would mean either the pump waits on somebody else's HTTP
// endpoint, which stops every rule in the product while it does, or every logging notifier in the
// codebase grows a queue it has no use for.
//
// The other half of the split is who is called at all. The engine hands the notifier every alert
// and hands this only the ones whose rule asked for a channel that leaves — so an alarm with no
// actions, or with screen alone, never reaches a dispatcher.
//
// Raised and Resolved are separate calls for IAlertNotifier's reason, and one more of their own:
// the spec has the resolved body carrying two members the raised body does not, and a single
// method would make each implementation unpack a record to find out which body to build.
public interface IAlertDispatcher
{
    Task RaisedAsync(IReadOnlyList<Alert> alerts);

    Task ResolvedAsync(IReadOnlyList<Alert> alerts);
}
