using System.Collections.Concurrent;
using System.Text;
using System.Threading.Channels;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using MqttForge.Application.Alerts;
using MqttForge.Application.Flows;
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
//
// And it publishes from a loop of its own, in the order the alarms happened. Both engines hand
// their alarms over on their pumps, and a publish waited for there held every rule and every flow
// for as long as the broker took, one alarm at a time: a lost link that ends a thousand retained
// alarms is a thousand bodies and a thousand clears. So the engines only hand over, and this loop
// waits. One loop, and so one order for everything: the publications on a topic — which is all the
// broker knows an alarm by — go out in the order they happened.
public sealed class MqttAlertDispatcher : IAlertDispatcher
{
    /// <summary>What a user's topic may carry, and what it expands to.</summary>
    // One literal, in one place. Two copies of "{topic}" is one edit away from a saved
// rule that stops expanding at dispatch, and nothing would say so.
    public const string TopicPlaceholder = AlertTopicPrefix.Placeholder;

    /// <summary>Alarm events kept for a broker slow to take them before any are let go.</summary>
    // Four times what may stand at once across the two engines that hand alarms over — a thousand
    // rule alarms and a thousand flow alarms — for AlertBacklog's reason: past it, the alarms that
    // came and went while the broker was slow go, and what is left is never more than twice that.
    public static readonly int QueueCapacity = 4 * (new AlertEngineOptions().MaxActiveAlerts + FlowLimits.StandingAlarms);

    /// <summary>How long any one publish out of this class may take.</summary>
    // Long enough for a publish the broker is going to accept, short enough that a broker which
    // has already gone does not hold anything open. It is the ceiling on every publish and not
    // only on the clears: the alarms go out one at a time, so a publish with no deadline is every
    // alarm behind it waiting on one dead socket. The shutdown uses it twice more: as the most it
    // waits for the loop to stop, and as the budget for the whole sweep.
    private static readonly TimeSpan ClearBudget = TimeSpan.FromSeconds(2);

    private readonly IMqttPublisher _publisher;
    private readonly AlertEngineOptions _options;
    private readonly ILogger<MqttAlertDispatcher> _log;

    // Every topic that is holding a retained alert body right now, and the QoS it was written
    // with. Kept here rather than read back off the engine's snapshot because the question this
    // answers is not "what is ringing" but "what did I leave on the broker" — and those two
    // differ exactly when it matters, which is a rule that was deleted while its alarm stood.
    private readonly ConcurrentDictionary<string, int> _retained = new(StringComparer.Ordinal);

    private readonly AlertBacklog _waiting = new(QueueCapacity);

    // Rung whenever there is something to publish, and read empty by the loop before it publishes
    // it all. One ring is enough however many came, so a second one is simply not kept.
    private readonly Channel<bool> _bell = Channel.CreateBounded<bool>(
        new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.DropWrite, SingleReader = true });

    private readonly CancellationTokenSource _stopping = new();
    private readonly Task _sending;

    private int _undelivered;
    private int _refused;

    // Alarm events handed over and not yet published or given up on: waiting, or in the loop's hands.
    private int _pending;

    /// <summary>Publishes that never left, because the link was down. Not errors.</summary>
    public int Undelivered => Volatile.Read(ref _undelivered);

    /// <summary>Publishes refused because the topic would have left the alert prefix.</summary>
    public int Refused => Volatile.Read(ref _refused);

    /// <summary>Alarm events handed over and not yet published or given up on.</summary>
    public int Pending => Volatile.Read(ref _pending);

    public MqttAlertDispatcher(IMqttPublisher publisher, AlertEngineOptions options,
                              ILogger<MqttAlertDispatcher> log,
                              IHostApplicationLifetime? lifetime = null)
    {
        _publisher = publisher;
        _options = options;
        _log = log;

        _sending = Task.Run(() => SendLoopAsync(_stopping.Token));

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
            Stop();

            using var budget = new CancellationTokenSource(ClearBudget);

            ClearRetainedAsync(budget.Token).GetAwaiter().GetResult();
        });
    }

    // Handed over and never waited for: the callers are the engines' pumps. See the class comment.
    public Task RaisedAsync(IReadOnlyList<Alert> alerts)
    {
        Hand(alerts, raised: true);

        return Task.CompletedTask;
    }

    public Task ResolvedAsync(IReadOnlyList<Alert> alerts)
    {
        Hand(alerts, raised: false);

        return Task.CompletedTask;
    }

    private void Hand(IReadOnlyList<Alert> alerts, bool raised)
    {
        // Once the process is stopping nothing more is taken: the sweep takes back every record
        // this process left, and a raise published in its last moments would be one more to chase.
        if (_stopping.IsCancellationRequested) return;

        List<AlertEvent>? events = null;
        foreach (var alert in alerts)
            if (alert.Actions.Any(action => action is PublishAction))
                (events ??= []).Add(new AlertEvent(alert, raised));

        if (events is null) return;

        // Counted before they are added and less what the backlog let go, so the count is never
        // short of what is really waiting.
        Interlocked.Add(ref _pending, events.Count);

        var letGo = _waiting.Add(events);
        if (letGo > 0) Interlocked.Add(ref _pending, -letGo);

        _bell.Writer.TryWrite(true);
    }

    /// <summary>The loop: everything waiting, in order, one alarm at a time.</summary>
    private async Task SendLoopAsync(CancellationToken ct)
    {
        try
        {
            while (await _bell.Reader.WaitToReadAsync(ct))
            {
                _bell.Reader.TryRead(out _);

                while (_waiting.Take() is { } taken)
                {
                    Say(taken);

                    foreach (var one in taken.Events)
                    {
                        // Stopped: what is left of this batch goes with the process, and the sweep
                        // takes back whatever it had left on the broker.
                        if (ct.IsCancellationRequested) return;

                        try
                        {
                            await SendAsync(one, ct);
                        }
                        catch (Exception ex) when (!ct.IsCancellationRequested)
                        {
                            // Nothing escapes the loop: a fault in one alarm's publication is that
                            // alarm's, and the ones behind it still go.
                            _log.LogError(ex, "An alarm could not be published to the broker.");
                        }
                        finally
                        {
                            Interlocked.Decrement(ref _pending);
                        }
                    }
                }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Stopped. See Stop.
        }
        catch (Exception ex)
        {
            // A fault in the reading itself, which nothing here expects. Nothing can be done about
            // it, but the alternative to saying so is a channel that quietly stopped publishing.
            _log.LogError(ex, "The broker's alarm channel stopped publishing.");
        }
    }

    // Said once the broker is taking again, rather than every time the backlog was cut back.
    private void Say(AlertBacklog.Taken taken)
    {
        if (taken.Untold > 0)
            _log.LogWarning("{Count} alarms went up and came down while the broker was slow to take their publications. " +
                            "They were not published; the log has them.", taken.Untold);

        if (taken.Lost > 0)
            _log.LogWarning("The broker fell {Count} alarm publications behind, and the oldest were let go.", taken.Lost);
    }

    /// <summary>Stops the loop before the sweep, and says what was still waiting.</summary>
    // The loop goes first, and is waited for, briefly: a publication still in flight when the sweep
    // ran could put back a record the sweep had just taken, and one still waiting could add one
    // after it. Its token calls off the publish in flight, so the wait is short.
    private void Stop()
    {
        _stopping.Cancel();
        _bell.Writer.TryComplete();

        if (!_sending.Wait(ClearBudget))
            _log.LogWarning("The broker's alarm channel did not stop within {Seconds} seconds.", ClearBudget.TotalSeconds);

        if (Pending > 0)
            _log.LogWarning("{Count} alarm publication(s) were still waiting when MQTTForge stopped. " +
                            "The retained records are taken back all the same.", Pending);
    }

    private async Task SendAsync(AlertEvent one, CancellationToken ct)
    {
        var alert = one.Alert;
        var @event = one.Raised ? "raised" : "resolved";

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

            if (one.Raised)
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
