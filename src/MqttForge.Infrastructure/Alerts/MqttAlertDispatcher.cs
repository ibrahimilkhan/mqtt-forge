using System.Collections.Concurrent;
using System.Text;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using MqttForge.Application.Alerts;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;

namespace MqttForge.Infrastructure.Alerts;

/// <summary>
/// The alert, published back to the broker under the alerting prefix.
/// </summary>
// The channel that answers "who watches the watcher": a plant already has a broker, and everything
// on that plant already knows how to subscribe to it. Publishing the alert there costs the user no
// new integration at all.
//
// Two things make this different from the other three channels. It writes to the very broker the
// engine is subscribed to — so the prefix is not a naming convention here, it is the loop guard —
// and a retained publish outlives the process that made it, which is why this class keeps a
// record of what it has left lying about and takes it back on the way out.
public sealed class MqttAlertDispatcher : IAlertDispatcher
{
    /// <summary>What a user's topic may carry, and what it expands to.</summary>
    // One literal, in one place. Two copies of "{topic}" is one edit away from a saved
// rule that stops expanding at dispatch, and nothing would say so.
    public const string TopicPlaceholder = AlertTopicPrefix.Placeholder;

    /// <summary>How long any one publish out of this class may take.</summary>
    // Long enough for a publish the broker is going to accept, short enough that a broker which
    // has already gone does not hold anything open. It is the ceiling on every publish and not
    // only on the clears: the raise path runs on the engine's own pump, so a publish with no
    // deadline is every rule in the product waiting on one dead socket. The shutdown callback
    // uses it a second time as the budget for the whole sweep.
    private static readonly TimeSpan ClearBudget = TimeSpan.FromSeconds(2);

    private readonly IMqttPublisher _publisher;
    private readonly AlertEngineOptions _options;
    private readonly ILogger<MqttAlertDispatcher> _log;

    // Every topic that is holding a retained alert body right now, and the QoS it was written
    // with. Kept here rather than read back off the engine's snapshot because the question this
    // answers is not "what is ringing" but "what did I leave on the broker" — and those two
    // differ exactly when it matters, which is a rule that was deleted while its alarm stood.
    private readonly ConcurrentDictionary<string, int> _retained = new(StringComparer.Ordinal);

    private int _undelivered;
    private int _refused;

    /// <summary>Publishes that never left, because the link was down. Not errors.</summary>
    public int Undelivered => Volatile.Read(ref _undelivered);

    /// <summary>Publishes refused because the topic would have left the alert prefix.</summary>
    public int Refused => Volatile.Read(ref _refused);

    public MqttAlertDispatcher(IMqttPublisher publisher, AlertEngineOptions options,
                              ILogger<MqttAlertDispatcher> log,
                              IHostApplicationLifetime? lifetime = null)
    {
        _publisher = publisher;
        _options = options;
        _log = log;

        // ApplicationStopping and not ApplicationStopped, and blocking rather than fire-and-forget:
        // this callback is holding the shutdown open precisely long enough for the clears to reach
        // a broker the process is about to disconnect from. A clear that raced the disconnect is a
        // clear that never happened, and a retained "critical" hanging on a broker after the alarm
        // has gone is, in the spec's words, worse than the alarm.
        //
        // Which is also why the token below is not decoration. GetAwaiter().GetResult() blocks the
        // host's shutdown thread, so a sweep with no ceiling on it is the host's ten-second budget
        // blown and a container that has to be killed instead of stopped.
        lifetime?.ApplicationStopping.Register(() =>
        {
            using var budget = new CancellationTokenSource(ClearBudget);

            ClearRetainedAsync(budget.Token).GetAwaiter().GetResult();
        });
    }

    // The interface carries no token, and this is where that stops being true. CancellationToken.None
    // is honest here: nothing above this line has a token to give, and every publish underneath
    // gets its own deadline regardless.
    public Task RaisedAsync(IReadOnlyList<Alert> alerts) =>
        SendAsync(alerts, "raised", clearing: false, CancellationToken.None);

    public Task ResolvedAsync(IReadOnlyList<Alert> alerts) =>
        SendAsync(alerts, "resolved", clearing: true, CancellationToken.None);

    private async Task SendAsync(IReadOnlyList<Alert> alerts, string @event, bool clearing,
                                 CancellationToken ct)
    {
        foreach (var alert in alerts)
            foreach (var action in alert.Actions)
            {
                if (action is not PublishAction publish) continue;

                if (TopicFor(alert, publish) is not { } topic) continue;

                var body = Encoding.UTF8.GetBytes(AlertPayload.For(alert, @event));

                // A body that never left is not a record to be taken back: the topic stays in the
                // list so the shutdown clear tries it again when the link may be up.
                if (!await PublishAsync(topic, body, publish.Qos, publish.Retain, alert.RuleName, ct))
                    continue;

                if (!publish.Retain) continue;

                if (!clearing)
                {
                    _retained[topic] = publish.Qos;

                    continue;
                }

                // The order is the whole of it: the resolved body first, so anybody listening
                // hears the alarm end, and then nothing at all, so anybody subscribing tomorrow is
                // not told about it at all.
                await ClearAsync(topic, publish.Qos, ct);
                _retained.TryRemove(topic, out _);
            }
    }

    /// <summary>Takes back every retained record this process has left on the broker.</summary>
    // Called on ApplicationStopping, and public so a test can ask for it directly.
    public async Task ClearRetainedAsync(CancellationToken ct)
    {
        foreach (var (topic, qos) in _retained)
        {
            if (ct.IsCancellationRequested) return;

            // Removed first. A clear that fails on a broker that has already gone is not worth a
            // second attempt from a process that is going with it.
            _retained.TryRemove(topic, out _);
            await ClearAsync(topic, qos, ct);
        }
    }

    private Task ClearAsync(string topic, int qos, CancellationToken ct) =>
        PublishAsync(topic, [], qos, retain: true, what: "the retained record", ct);

    /// <summary>Where this alert goes, or null if it may not go anywhere.</summary>
    private string? TopicFor(Alert alert, PublishAction action)
    {
        // The default names the pair, because the alert is the pair. A topic naming the rule alone
        // would send a hundred topics' alarms to one address, and with retain the last writer
        // would be the only one anybody ever sees. The rule's name is deliberately not used: it is
        // free text, it can hold characters a topic segment may not, and editing it would silently
        // move where the alarms go.
        if (string.IsNullOrEmpty(action.Topic))
            return _options.TopicPrefix + alert.RuleId + "/" + alert.Topic;

        var expanded = AlertTopicPrefix.Expand(action.Topic, alert.Topic);

        if (expanded.StartsWith(_options.TopicPrefix, StringComparison.Ordinal)) return expanded;

        // Checked here as well as at save, and the two checks are not the same check. Saving sees
        // a topic with a placeholder in it; this sees what the broker would actually be told, and
        // "{topic}/alarm" passes the first and fails this one. A rule saved before the prefix
        // setting was changed lands here too.
        Interlocked.Increment(ref _refused);

        _log.LogWarning(
            "The rule {RuleName} publishes to '{Topic}', which is outside the alert prefix " +
            "'{Prefix}'. Nothing was published: the engine would be listening to itself.",
            alert.RuleName, expanded, _options.TopicPrefix);

        return null;
    }

    private async Task<bool> PublishAsync(string topic, byte[] payload, int qos, bool retain,
                                          string what, CancellationToken ct)
    {
        // Its own ceiling as well as the caller's. MqttnetPublisher hands the token straight to
        // MQTTnet, and a socket that is open but dead answers neither the publish nor anything
        // else — which on the raise path is the engine's pump stopped dead, and on the shutdown
        // path is a container that has to be killed rather than stopped.
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(ClearBudget);

        try
        {
            await _publisher.PublishAsync(new PublishRequest(topic, payload, qos, retain),
                                          deadline.Token);

            return true;
        }
        catch (NotConnectedException)
        {
            // The spec, in as many words: a publish with the link down is not sent, is not queued,
            // and is counted. Queueing it would deliver an alarm about a moment that has passed to
            // an audience that has already seen the connection go, and throwing would reach the
            // engine as a notifier fault — a sentence about the wrong thing entirely.
            Interlocked.Increment(ref _undelivered);

            _log.LogWarning(
                "{What} for {Topic} was not published: MQTTForge is not connected to a broker.",
                what, topic);

            return false;
        }
        catch (Exception ex)
        {
            // A broker entitled to refuse the topic, a message it calls too large — and
            // OperationCanceledException with them, deliberately and with no filter excluding it.
            // A publish this class gave up on is a publish that did not land, which is the one
            // thing the counter means; and a filter that let it past would send a cancellation
            // straight up into the engine's DeliverAsync, which is the caller this whole method
            // exists to keep exceptions away from.
            Interlocked.Increment(ref _undelivered);

            _log.LogWarning(ex, "{What} for {Topic} could not be published.", what, topic);

            return false;
        }
    }
}
