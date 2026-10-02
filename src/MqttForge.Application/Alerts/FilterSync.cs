using Microsoft.Extensions.Logging;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Alerts;

/// <summary>
/// One pump's own filters at the broker: which it holds, which the broker refused on this link, and
/// how long to leave them after a broker that did not answer. The alert rules have one, and the
/// flows another, each under its own owner; when to ask is the pump's.
/// </summary>
// A diff and not a refresh. Re-sending the whole set every time would make the broker replay every
// retained value under every filter on each pass, which is an alarm storm on a timer.
public sealed class FilterSync(
    IMqttSubscriber subscriber, SubscriptionOwner owner, int qos, TimeProvider time, ILogger log, string whose)
{
    /// <summary>Filters this broker has refused on this link. Not asked for again until the link or what is wanted changes.</summary>
    private readonly HashSet<string> _refused = new(StringComparer.Ordinal);

    /// <summary>How long the filters are put off, after a broker that did not answer for them. See AlertEngine.NoAnswerPause.</summary>
    private readonly NoAnswerBackoff _noAnswer = new();

    /// <summary>What an attempt came to: whether everything wanted is now held, and what the broker refused.</summary>
    public readonly record struct Outcome(bool Done, IReadOnlyList<string> Refused);

    public bool IsRefused(string filter) => _refused.Contains(filter);

    /// <summary>Whether a filter wanted, and not refused, is not held.</summary>
    public bool Missing(IEnumerable<string> wanted)
    {
        var held = Held();

        foreach (var filter in wanted)
            if (!held.Contains(filter) && !_refused.Contains(filter))
                return true;

        return false;
    }

    /// <summary>Whether the broker did not answer so lately that asking again now would only wait on it again.</summary>
    public bool Pausing(DateTimeOffset now) => _noAnswer.Pausing(now);

    /// <summary>
    /// A new link, or a link to another broker: a new answer. The broker may have been restarted with
    /// a different ACL, or be another broker altogether, so what was refused is asked for again, and
    /// nothing is put off.
    /// </summary>
    public void NewLink()
    {
        _refused.Clear();
        _noAnswer.Lift();
    }

    /// <summary>
    /// The reader changed what is wanted — saved a rule, deployed a flow — which is the other way a
    /// refused filter becomes worth asking about again, most obviously by being narrowed. And they are
    /// waiting to see it at work, so the next attempt goes at once, whatever pause a broker that did
    /// not answer left; the run of pauses goes on if it leaves that attempt unanswered too.
    /// </summary>
    public void Changed()
    {
        _refused.Clear();
        _noAnswer.Interrupt();
    }

    /// <summary>
    /// Puts up the wanted filters not held, and takes down the held ones no longer wanted. Only on a
    /// connected client: there is nothing to subscribe on one that is not, and nothing to take down.
    /// </summary>
    public async Task<Outcome> SyncAsync(IReadOnlySet<string> wanted, CancellationToken ct)
    {
        var held = Held();

        var missing = new List<SubscriptionRequest>();
        foreach (var filter in wanted)
            if (!held.Contains(filter) && !_refused.Contains(filter))
                missing.Add(new SubscriptionRequest(filter, qos));

        var gone = new List<string>();
        foreach (var filter in held)
            if (!wanted.Contains(filter))
                gone.Add(filter);

        try
        {
            // One SUBSCRIBE for the lot: the round trip costs the same whether it carries one
            // filter or a hundred, and it is the round trip that makes subscribing in bulk slow.
            if (missing.Count > 0)
                await subscriber.SubscribeAsync(missing, ct, owner);

            // One at a time, because that is the shape UNSUBSCRIBE has here — and because a
            // filter the console also holds must survive, which is the subscriber's ownership
            // arithmetic and not this loop's business.
            foreach (var filter in gone)
                await subscriber.UnsubscribeAsync(filter, ct, owner);

            _noAnswer.Answered();
            return new Outcome(true, []);
        }
        catch (MessageRejectedException refusal)
        {
            // An answer as much as a grant is, so the next silence is the first of a new run.
            _noAnswer.Answered();

            // The broker said no to these, so they are not asked for again on this link: it would
            // say no again, once a second, for as long as the link lasted. Whatever else was in
            // the packet is still wanted, so the attempt is not done and the next turn asks for the
            // rest — which is also how a session the broker closed over one filter comes back with
            // the others. What the broker named, or — when it named nothing, which is what an older
            // broker closing the session amounts to — everything this packet asked for: either way
            // the pump must come away knowing not to ask again.
            IReadOnlyList<string> refused = refusal.Filters.Count > 0
                ? refusal.Filters
                : [.. missing.Select(request => request.TopicFilter)];

            foreach (var filter in refused) _refused.Add(filter);

            log.LogWarning(refusal,
                "The broker refused {Count} {Whose} filter(s); they will not be asked for again on this link.",
                refused.Count, whose);

            return new Outcome(false, refused);
        }
        catch (BrokerDidNotAnswerException silence)
        {
            // Not a refusal, and not for the very next turn either: see AlertEngine.NoAnswerPause.
            // The attempt is not done, so the first turn after the pause asks again.
            var pause = _noAnswer.NotAnswered(time.GetUtcNow());

            log.LogWarning(silence,
                "The broker did not answer for the {Whose} subscriptions. They will be asked for again in {Seconds} seconds.",
                whose, pause.TotalSeconds);

            return new Outcome(false, []);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            // Everything else — a link that went in the middle of the packet, a fault nobody
            // foresaw. None of it may stop the pump, and none of it is permanent: the next turn
            // asks again.
            //
            // A cancellation is one of these unless it is the pump's own. MQTTnet 5 can fail a
            // SUBSCRIBE that was waiting when its keep-alive gave up on the link with the
            // cancellation of its own receive loop, which is the link going and not the pump
            // stopping — and letting that through would also lose everything else the turn decided.
            log.LogWarning(ex, "Could not apply the {Whose} subscriptions. They will be asked for again.", whose);

            return new Outcome(false, []);
        }
    }

    /// <summary>The filters the subscriber holds on this pump's behalf, whoever else holds them too.</summary>
    // Only what this pump owns. A filter the console put up is the console's business, and
    // unsubscribing it because nothing here wants it would empty the user's own Filters panel.
    private HashSet<string> Held()
    {
        var held = new HashSet<string>(StringComparer.Ordinal);

        foreach (var filter in subscriber.Filters)
            if (filter.Owners.HasFlag(owner))
                held.Add(filter.Filter);

        return held;
    }
}
