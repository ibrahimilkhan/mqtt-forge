using System.Globalization;
using System.Net.Http;
using System.Text;
using System.Threading.Channels;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using MqttForge.Application.Alerts;
using MqttForge.Application.Flows;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;

namespace MqttForge.Infrastructure.Alerts;

/// <summary>
/// The alert, POSTed to an address the user gave — and a Webhook node's post, to the address its node
/// gives. One bounded queue, one pump, four deliveries in flight and no more than two of them a flow's,
/// and one at a time per endpoint for each kind.
/// </summary>
// Shaped after SignalRMessageNotifier — a bounded channel written to from a path that may not
// block, and a pump that owns everything slow — and it differs from it in exactly one place, on
// purpose: FullMode is DropWrite, not DropOldest. There, the oldest message is the stalest and
// letting it go is the right trade. Here, the item at the front of the queue may already be
// halfway through a POST that an endpoint has half received, and taking it away would leave a
// delivery nobody can account for. The newest goes instead, and Dropped is what the panel shows.
//
// It is an IHostedService for the sake of StopAsync alone. A container restart is the ordinary
// way this process ends — 'restart: unless-stopped' is the documented deployment — and a queue
// that went with it silently would eat the alarm that prompted the restart.
//
// Two kinds of delivery are made here, and that one class makes both is the point of it. A rule's
// alarm and a Webhook node's post are each a POST to an address somebody typed, and what the
// operator turns off with MqttForge:AllowWebhooks, what is never followed through a redirect and
// what the panel counts as dropped should be one queue, one client and one set of attempts — not
// two, which would be two places to forget a gate. They differ in where the body comes from and in
// who hears of a failure: an alert's body is made from the alert when it is sent, and a delivery
// given up on is a line in the log; a flow's is the body its node rendered, and its node is told
// as well, because a post that never lands is a step that failed.
//
// And they differ in how many there can be, which is why they never share a line and do not share
// the slots evenly. A rule's alarm goes out when an alarm goes up or comes down; a flow can ask for
// a post every second from every Webhook node it has, for as long as it runs. So the flows' posts
// are capped, in all (FlowPostsWaiting) and at each endpoint (FlowPostsPerEndpoint), wait in lines
// of their own (Chain), and may hold half the slots and no more (FlowsInFlight): a flow posting to
// a host that has stopped answering costs the posts to that host their time and their places, the
// flows' posts to other hosts one of their two slots, and a rule's alarm none of it.
public sealed class WebhookDispatcher : IAlertDispatcher, IFlowWebhook, IHostedService
{
    /// <summary>The named client the wiring builds with <see cref="CreateHandler"/>.</summary>
    // This constant and CreateHandler exist for the container's benefit alone, and they are the
    // reason this class MUST NEVER BE REGISTERED BY TYPE. AddHttpClient(name) also registers a
    // bare transient HttpClient bound to the UNNAMED client, so AddSingleton<WebhookDispatcher>()
    // resolves perfectly happily and hands this class the default handler — which follows
    // redirects, which is the single thing CreateHandler exists to prevent, and which fails
    // silently with every test in this file still green. The wiring asks IHttpClientFactory for
    // this name and passes the client it gets into the constructor.
    public const string ClientName = "alert-webhook";

    /// <summary>How many deliveries may be waiting before the newest are dropped and counted.</summary>
    // A thousand and twenty-four, which at the spec's own worst case — a connection dropping and
    // every silence rule ringing at once — is more than one storm's worth.
    public const int QueueCapacity = 1024;

    /// <summary>How many endpoints are talked to at the same time.</summary>
    public const int MaxInFlight = 4;

    /// <summary>How many of the <see cref="MaxInFlight"/> may be a flow's post at the same time.</summary>
    // Half, so that however many hosts the flows' posts are waiting on, two slots are always free for a
    // rule's alarm. Without it, four posts to four hosts that have stopped answering would hold every slot
    // for their twenty seconds each, and then the next four, and an alarm to a host that would have answered
    // at once would wait for all of them.
    //
    // A delivery holds its slots only while it makes an attempt, and gives them back for each wait between
    // two (see PostAsync), so two receivers that answer with errors hold the flows' two for the moments their
    // answers take, and the posts to every other host go out in between. Two that never answer still hold
    // both through each attempt they are given, ten seconds apiece, and the posts to other hosts then go out
    // in the second between their attempts and as each of their posts is given up on.
    public const int FlowsInFlight = 2;

    /// <summary>
    /// How many of the flows' posts, to every endpoint together, may be waiting or on their way before the
    /// newest is refused.
    /// </summary>
    // The queue's capacity cannot be this number. While the pump runs, the queue is empty again the moment
    // a delivery arrives — the pump moves each one on into its endpoint's chain at once — and a chain is as
    // long as its endpoint is slow. A flow can ask for a post every second from every Webhook node it has,
    // and each post carries the body its node rendered, up to 64 KB of it, where an alert's is made when it
    // is sent. So the flows' posts are counted from Post until their last attempt has ended, and past this
    // many the newest is refused — answered false, which the engine counts on the node that asked — and
    // counted as dropped, as one the full queue lets go is.
    //
    // A hundred and twenty-eight is more than two for each of the fifty flows a host keeps, which is room
    // enough while the hosts answer. It bounds the memory the flows' posts can hold, and no longer what one
    // receiver can keep waiting, which is FlowPostsPerEndpoint: it takes eight receivers that have stopped
    // answering to fill it, and a hundred and twenty-eight bodies are then all they can keep between them,
    // rather than one for every second they have been down.
    public const int FlowPostsWaiting = 128;

    /// <summary>
    /// How many of the flows' posts to one endpoint may be waiting or on their way before the newest to it is
    /// refused.
    /// </summary>
    // One receiver that has stopped answering, or answers every post with an error, must hold up the posts
    // to itself and nobody else's: Chain's rule for the order the posts go in, kept here for how many of
    // them may wait. Every answer but a 2xx is tried again, so a post to a receiver that answers 404 or 500
    // takes about three seconds to be given up on, and one to a receiver that never answers takes its
    // twenty, while a Webhook node asks again every second. Held only to FlowPostsWaiting, that one address
    // would fill it in two or three minutes, and from then on every flow's posts, to every host, would be
    // refused and counted on nodes that had done nothing wrong.
    //
    // Sixteen leaves room for a burst to one receiver while it answers — a message that sets off every
    // Webhook node posting to one Node-RED at once — and it takes eight receivers failing at the same time
    // to fill the hundred and twenty-eight.
    public const int FlowPostsPerEndpoint = 16;

    /// <summary>How many times one delivery is offered to one endpoint.</summary>
    public const int MaxAttempts = 3;

    /// <summary>How long one attempt may take.</summary>
    public static readonly TimeSpan AttemptTimeout = TimeSpan.FromSeconds(10);

    /// <summary>The whole life of one delivery, attempts and waits together.</summary>
    // Three ten-second attempts and the waits between them come to thirty-three seconds, all of
    // it at the head of one endpoint's queue. Twenty is where that stops.
    public static readonly TimeSpan Budget = TimeSpan.FromSeconds(20);

    /// <summary>How long shutdown gives the queue before what is left is written off.</summary>
    // Four, inside the host's ten-second ShutdownTimeout and comfortably outside the default five
    // seconds, which is smaller than a single attempt and would have made this budget a fiction.
    public static readonly TimeSpan DrainBudget = TimeSpan.FromSeconds(4);

    private static readonly TimeSpan FirstBackoff = TimeSpan.FromSeconds(1);

    /// <summary>One post: where it goes, with which headers, and what it carries.</summary>
    // An alert's body is made from the alert when it is sent, a flow's is the body its node rendered.
    // Everything after that — the attempts, the budget, the client — is one path. Which kind a delivery
    // is decides the rest: the line it waits in, the slots it may take, what the log calls it, and
    // whether a node is told when it is given up on.
    private abstract record Delivery(string Url, IReadOnlyDictionary<string, string> Headers, string ContentType)
    {
        /// <summary>The endpoint this delivery goes to: the line it waits in, and where a flow's post is counted.</summary>
        // Worked out once, so that the count a flow's post is held to when it is taken and the count it gives
        // its place back to when it ends are the same one by construction rather than by two parses agreeing.
        public string Endpoint { get; } = EndpointOf(Url);

        /// <summary>Set by <see cref="OnDropped"/> when the queue let this one go instead of taking it.</summary>
        // The only way the writer can tell: see Post. Set and read by the thread that wrote the delivery,
        // which is the thread the queue calls OnDropped on, so it is not shared with anything.
        public bool LetGo { get; set; }

        public abstract string Body();
    }

    /// <summary>A rule's alarm, raised or resolved, to one of the rule's webhooks.</summary>
    private sealed record AlertDelivery(Alert Alert, string Event, WebhookAction Webhook)
        : Delivery(Webhook.Url, Webhook.Headers, "application/json")
    {
        public override string Body() => AlertPayload.For(Alert, Event);
    }

    /// <summary>A Webhook node's post, and who to tell when it is given up on.</summary>
    private sealed record FlowDelivery(FlowWebhookPost Post, Action<string> Failed)
        : Delivery(Post.Url, NoHeaders, Post.ContentType)
    {
        public override string Body() => Post.Body;
    }

    // A Webhook node has no headers to give, and one empty set does for every post.
    private static readonly IReadOnlyDictionary<string, string> NoHeaders = new Dictionary<string, string>();

    private readonly HttpClient _client;
    private readonly AlertEngineOptions _options;
    private readonly ILogger<WebhookDispatcher> _log;
    private readonly AlertPanelCounters? _panel;
    private readonly TimeProvider _time;
    private readonly Channel<Delivery> _queue;
    private readonly SemaphoreSlim _slots = new(MaxInFlight, MaxInFlight);
    private readonly SemaphoreSlim _flowSlots = new(FlowsInFlight, FlowsInFlight);
    private readonly CancellationTokenSource _stopping = new();

    // One task per line — a kind of delivery and an endpoint — each the tail of that line's chain.
    // Touched by the pump thread and nothing else — the channel is SingleReader — so there is no lock
    // on it.
    private readonly Dictionary<(bool Flow, string Endpoint), Task> _chains = [];

    private Task? _pump;
    private int _dropped;
    private int _pending;
    private int _saidWebhooksAreOff;

    // The flows' posts among _pending, in all and at each endpoint: what FlowPostsWaiting and
    // FlowPostsPerEndpoint are held against. Raised in Admitted, on the thread that posted, and lowered in
    // Ended, on whichever thread a post ended on, so both are under this lock — the dictionary cannot be
    // written from two threads at once, and a post is checked against both caps and counted against both
    // in one step. An endpoint is taken out when its last post ends, or every address a flow, or a Test of
    // one, ever posted to would stay in it for the life of the process.
    private readonly Lock _flowCountLock = new();
    private readonly Dictionary<string, int> _flowPostsAt = new(StringComparer.Ordinal);
    private int _flowPosts;

    /// <summary>
    /// Deliveries let go: by a full queue, or a flow's post past <see cref="FlowPostsWaiting"/> or
    /// <see cref="FlowPostsPerEndpoint"/>. The panel's <c>webhooksDropped</c>.
    /// </summary>
    public int Dropped => Volatile.Read(ref _dropped);

    /// <summary>
    /// Deliveries queued, waiting in their line or in flight. Read at shutdown to say what is being lost.
    /// </summary>
    public int Pending => Volatile.Read(ref _pending);

    // The panel goes last, after the clock, and both are optional. The tests build this
    // positionally with the clock fourth and the panel fifth, so a parameter inserted before the
    // TimeProvider would bind a FakeTimeProvider to an AlertPanelCounters and stop the whole test
    // file compiling. Optional because a caller with no panel to write to — a test that only cares
    // what went out on the wire — should still get a working dispatcher.
    public WebhookDispatcher(HttpClient client, AlertEngineOptions options,
                            ILogger<WebhookDispatcher> log, TimeProvider? timeProvider = null,
                            AlertPanelCounters? panel = null)
    {
        _client = client;
        _options = options;
        _log = log;
        _panel = panel;

        // MqttnetConnectionManager's signature exactly: production wires nothing, the tests hand
        // in a clock they can move.
        _time = timeProvider ?? TimeProvider.System;

        // This class is a singleton and owns its client, so this is not a setting taken from
        // under anybody. It has to be off: the attempt deadline below runs on the injected clock,
        // and HttpClient's own hundred seconds would be a second deadline on a clock no test can
        // reach — which is the difference between testing the ten-second rule and hoping.
        _client.Timeout = Timeout.InfiniteTimeSpan;

        _queue = Channel.CreateBounded<Delivery>(
            new BoundedChannelOptions(QueueCapacity)
            {
                FullMode = BoundedChannelFullMode.DropWrite,
                SingleReader = true,
            },
            OnDropped);
    }

    /// <summary>The handler the named client is built on.</summary>
    // Redirects are not followed, and the reason is in SECURITY.md rather than in HTTP: following
    // one would carry the Authorization header the user wrote for their own host to a host they
    // never named, chosen by whoever answered. A 3xx is a failure here, and it says so.
    //
    // PooledConnectionLifetime because this dispatcher holds one client for the life of the
    // process: without it, a webhook host whose address changes is posted to the old one until
    // the container is restarted.
    public static SocketsHttpHandler CreateHandler() => new()
    {
        AllowAutoRedirect = false,
        PooledConnectionLifetime = TimeSpan.FromMinutes(2)
    };

    /// <summary>The wait before attempt <paramref name="attempt"/> + 1. One, two, four.</summary>
    // Written as the doubling it is rather than as a table. Three attempts use the first two
    // rungs; the third exists so that moving MaxAttempts moves the ladder with it.
    public static TimeSpan BackoffFor(int attempt) => FirstBackoff * (1 << (attempt - 1));

    public Task RaisedAsync(IReadOnlyList<Alert> alerts) => Queue(alerts, "raised");

    public Task ResolvedAsync(IReadOnlyList<Alert> alerts) => Queue(alerts, "resolved");

    // Called from the engine's pump, which may not wait for anything. Writing to a DropWrite
    // channel never blocks and never throws.
    private Task Queue(IReadOnlyList<Alert> alerts, string @event)
    {
        foreach (var alert in alerts)
            foreach (var action in alert.Actions)
            {
                if (action is not WebhookAction webhook) continue;

                if (!_options.AllowWebhooks)
                {
                    SayWebhooksAreOff();

                    continue;
                }

                Interlocked.Increment(ref _pending);
                _queue.Writer.TryWrite(new AlertDelivery(alert, @event, webhook));
            }

        return Task.CompletedTask;
    }

    /// <summary>
    /// A Webhook node's post. Queued, never waited for: false when <see cref="FlowPostsWaiting"/> of the
    /// flows' posts are waiting already, or <see cref="FlowPostsPerEndpoint"/> of them at its endpoint, or
    /// when the queue is full or closed.
    /// </summary>
    // The gate is the engine's, which is given no webhook channel at all when AllowWebhooks is false; it
    // is checked here as well, for the reason the alert half checks it: a switch enforced in one place is
    // one forgotten branch away from doing nothing.
    //
    // Called from the flow engine's pump, which may not wait for anything, so it queues and goes. Nothing
    // in it throws: a refusal is the false, or the sentence handed to the failed callback, and never both.
    public bool Post(FlowWebhookPost post, Action<string> failed)
    {
        if (!_options.AllowWebhooks)
        {
            // Said back at once and answered true, because it was dealt with: a false would have the engine
            // count a full queue on the node on top of this. True does leave the node counting it as posted
            // beside its error, as no other refusal does; only a wiring that hands the engine this channel
            // with the switch off can get here.
            failed(IFlowWebhook.TurnedOff);
            return true;
        }

        var delivery = new FlowDelivery(post, failed);

        // The flows' caps come first. A post past either of them is refused and counted as dropped, and
        // nothing of it is kept.
        if (!Admitted(delivery))
        {
            CountDropped();

            return false;
        }

        // Counted before it is written, as Queue counts an alert: the pump may have finished it before
        // this thread reaches its next line.
        Interlocked.Increment(ref _pending);

        // False is a queue that has been closed. The delivery never went in, so nothing else will end it —
        // and it is not a drop either, because a closed queue is a host that is stopping and not one that
        // cannot keep up.
        if (!_queue.Writer.TryWrite(delivery))
        {
            Ended(delivery);

            return false;
        }

        // True is not "taken", though. A full DropWrite queue lets the newest go and answers as if it had
        // been written, which would tell the engine that a post was queued when nobody ever will send it.
        // OnDropped has already run, on this thread, before TryWrite returned: it marked the delivery,
        // ended it and counted it as dropped, so there is nothing to undo here.
        return !delivery.LetGo;
    }

    // Whether a flow's post fits under both of the flows' caps — the one for every endpoint together and
    // the one for its own — and if it does, it is counted against both. A post that does not fit is
    // counted against neither, so there is nothing to take back.
    private bool Admitted(FlowDelivery delivery)
    {
        lock (_flowCountLock)
        {
            var atEndpoint = _flowPostsAt.GetValueOrDefault(delivery.Endpoint);
            if (_flowPosts >= FlowPostsWaiting || atEndpoint >= FlowPostsPerEndpoint) return false;

            _flowPosts++;
            _flowPostsAt[delivery.Endpoint] = atEndpoint + 1;

            return true;
        }
    }

    // A switch an operator turned on purpose, said once. A line per alarm would bury the alarms
    // in an explanation of the configuration.
    private void SayWebhooksAreOff()
    {
        if (Interlocked.Exchange(ref _saidWebhooksAreOff, 1) != 0) return;

        _log.LogWarning(
            "A rule asked for a webhook, but MqttForge:AllowWebhooks is false. No webhook will " +
            "be sent while it stays false, and this is said once.");
    }

    // Called by the queue itself, on the writer's thread and before the write returns, and only for a
    // delivery it let go: with DropWrite that is the one being written. Never for one a pump took.
    private void OnDropped(Delivery job)
    {
        job.LetGo = true;

        Ended(job);
        CountDropped();
    }

    // A delivery let go, by the full queue or by one of the flows' caps.
    private void CountDropped()
    {
        Interlocked.Increment(ref _dropped);

        // The same drop, counted a second time where GET /api/alerts can read it. Dropped is this
        // class's own number and AlertPanelCounters is the panel's; they are one event, and the
        // controller cannot see this object. See AlertPanelCounters for why it is not on the
        // snapshot — the core is a pure function of messages and rules and has no idea a queue
        // out here overflowed.
        _panel?.WebhookDropped();
    }

    // The end of a delivery that was counted, whichever way it ends: sent or given up on (DeliverAsync),
    // let go by the full queue (OnDropped), or — a flow's post — refused by a closed one (Post). Once for
    // each and never twice, so that Pending is what is still to be done and the flows' caps count the
    // flows' posts that are. One left counted would be a place under a cap lost for the life of the
    // process.
    //
    // Pending goes last, so that whoever reads it at nought finds every place it stood for given back.
    //
    // The endpoint's count is looked up rather than indexed, so that a slip in this bookkeeping costs a
    // number and never an exception. Thrown here, it would come out of the queue's callback and through
    // Post, which the engine is promised never throws, or out of DeliverAsync's finally with Pending left
    // where it was.
    private void Ended(Delivery job)
    {
        if (job is FlowDelivery)
        {
            lock (_flowCountLock)
            {
                _flowPosts--;

                if (_flowPostsAt.TryGetValue(job.Endpoint, out var count))
                {
                    if (count > 1) _flowPostsAt[job.Endpoint] = count - 1;
                    else _flowPostsAt.Remove(job.Endpoint);
                }
            }
        }

        Interlocked.Decrement(ref _pending);
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _pump = Task.Run(PumpAsync, CancellationToken.None);

        return Task.CompletedTask;
    }

    /// <summary>
    /// Stops the retries, lets the queue out with one attempt each, and says what did not fit.
    /// </summary>
    // The order of the first two lines is the whole design. Stopping first means a delivery that
    // starts between them gets its one attempt and no ladder; completing first would let the last
    // few run the full thirty-three seconds while the host waits on them.
    public async Task StopAsync(CancellationToken cancellationToken)
    {
        await _stopping.CancelAsync();
        _queue.Writer.TryComplete();

        if (_pump is null) return;

        try
        {
            await _pump.WaitAsync(DrainBudget, _time, cancellationToken);
        }
        catch (Exception ex) when (ex is TimeoutException or OperationCanceledException)
        {
            // Not an error and not a retry: the process is going. Said out loud because an
            // endpoint that is missing an alert or a flow's post is entitled to know it was this
            // and not the network. Whatever is still in flight goes with the process a moment from
            // now. Deliveries and not alerts, because Pending counts both kinds. The number goes after
            // the sentence rather than inside it, which then reads right at one as it does at a
            // thousand, and it stays a value of its own for a log that a machine reads.
            _log.LogWarning(
                "Webhook deliveries still unsent when MQTTForge stopped: {Count}", Pending);
        }
    }

    private async Task PumpAsync()
    {
        try
        {
            // No cancellation token: the wait ends when the writer completes, which is what
            // StopAsync does. A token here would abandon the queue rather than drain it.
            while (await _queue.Reader.WaitToReadAsync())
                while (_queue.Reader.TryRead(out var job))
                    Chain(job);
        }
        catch (Exception ex)
        {
            // Reaching this line means a fault in the reading itself. Nothing can be done about
            // it, but the alternative to saying so is a channel that quietly stopped delivering.
            _log.LogError(ex, "The webhook pump stopped reading its queue.");
        }

        // Every line's chain, including what the drain just handed them. DeliverAsync never
        // throws, so this never does either.
        await Task.WhenAll([.. _chains.Values]);
    }

    /// <summary>Puts one delivery behind whatever its own line — its kind, at its endpoint — is already doing.</summary>
    // One at a time per endpoint, four endpoints at a time. The spec's "cevap vermeyen uç nokta
    // yalnızca kendi sırasını tıkasın": an address that has stopped answering must hold up its
    // own queue and nobody else's, and a chain per endpoint says that without a thread per
    // endpoint or a lock on the chains. (How many of the flows' posts may wait in one line is
    // the same rule kept for their number: see FlowPostsPerEndpoint.)
    //
    // A chain for each kind at each endpoint, and not one for both. A flow posting every second
    // to a host that has stopped answering is that host's queue as well, and in a single line a
    // rule's alarm to the same host would wait behind every post the flow had made, twenty seconds
    // apiece. So the flows' posts hold each other up and nothing else, and an alarm to the same
    // host goes beside them, as it would have before there were any.
    private void Chain(Delivery job)
    {
        var line = (job is FlowDelivery, job.Endpoint);
        var previous = _chains.TryGetValue(line, out var tail) ? tail : Task.CompletedTask;

        // Not ExecuteSynchronously: the continuation would then start on the pump thread and hold
        // it until the first real await, which is the one thread that must never wait for HTTP.
        _chains[line] = previous
            .ContinueWith(_ => DeliverAsync(job), CancellationToken.None,
                          TaskContinuationOptions.None, TaskScheduler.Default)
            .Unwrap();

        Prune(line);
    }

    // Lines, not deliveries, so this dictionary is small — but a rule set that names a hundred
    // hosts would still leave a hundred finished tasks in it for the life of the process.
    private void Prune((bool Flow, string Endpoint) keep)
    {
        List<(bool Flow, string Endpoint)>? finished = null;

        foreach (var (line, task) in _chains)
            if (task.IsCompleted && line != keep)
                (finished ??= []).Add(line);

        if (finished is null) return;

        foreach (var line in finished) _chains.Remove(line);
    }

    /// <summary>Scheme, host and port. Two paths on one host are one endpoint.</summary>
    // The host is what stops answering, not the path. A rule set with ten hooks on one Node-RED
    // would otherwise open ten conversations with a machine that is already struggling.
    internal static string EndpointOf(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) ? uri.GetLeftPart(UriPartial.Authority) : url;

    // The query string is dropped from anything logged: a webhook url is exactly the sort of
    // place a shared secret is written, and a log line is the last place it should be repeated.
    private static string Redacted(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) ? uri.GetLeftPart(UriPartial.Path) : url;

    private async Task DeliverAsync(Delivery job)
    {
        var slots = new Slots(_slots, job is FlowDelivery ? _flowSlots : null);

        try
        {
            // Taken with no token the first time: a delivery that has waited its turn in its line is given
            // its attempt, and at shutdown that is the one attempt StopAsync promises it.
            await slots.TakeAsync(CancellationToken.None);
            await PostAsync(job, slots);
        }
        catch (Exception ex)
        {
            // Nothing escapes: this task is the pump's, and a delivery that threw here would take
            // its endpoint's whole chain with it.
            _log.LogError(ex, "A webhook delivery failed in a way nothing expected.");
        }
        finally
        {
            // The slots before the count, so that nothing the bookkeeping does can keep a slot from coming
            // back: a slot lost is one of four for the life of the process. Ended goes last for its own
            // reason, which is Pending's.
            slots.Release();
            Ended(job);
        }
    }

    private async Task PostAsync(Delivery job, Slots slots)
    {
        // The whole life of this delivery, retries and waits included, ends at this instant.
        using var budget = new CancellationTokenSource(Budget, _time);

        var body = job.Body();

        for (var attempt = 1; attempt <= MaxAttempts; attempt++)
        {
            var (delivered, reason) = await AttemptAsync(job, body, budget.Token);
            if (delivered) return;

            if (attempt == MaxAttempts || budget.IsCancellationRequested)
            {
                GiveUp(job, attempt, reason);

                return;
            }

            using var wait = CancellationTokenSource.CreateLinkedTokenSource(
                budget.Token, _stopping.Token);

            // The slots are given back for the wait and taken again after it, under the same two deadlines.
            // A slot is for talking to an endpoint, and a delivery waiting to try again is talking to nobody:
            // held through its waits, two receivers answering errors kept their slots for most of every
            // delivery's life, and a post or an alarm to a host that answers waited behind them.
            slots.Release();

            try
            {
                await Task.Delay(BackoffFor(attempt), _time, wait.Token);
                await slots.TakeAsync(wait.Token);
            }
            catch (OperationCanceledException)
            {
                GiveUp(job, attempt,
                    budget.IsCancellationRequested
                        ? "the 20 second budget for this webhook ran out"
                        : "MQTTForge is stopping");

                return;
            }
        }
    }

    /// <summary>The slots one delivery holds while it makes an attempt: one of the four, and a flow's post one of the flows' two as well.</summary>
    // Its own, and touched by its delivery alone, one step after another, so it needs no lock. It knows
    // whether it holds them, so a release where there is nothing held — the finally after a wait that was
    // called off before they were taken again — gives back nothing it did not take.
    private sealed class Slots(SemaphoreSlim all, SemaphoreSlim? share)
    {
        private bool _held;

        // A flow's post takes one of the flows' own slots first, and only then one of the four, so the
        // flows can never hold more than FlowsInFlight of them. The other way round, a post waiting for
        // the flows' share would sit on one of the four while it waited, and the flows could hold every
        // one of them after all.
        public async Task TakeAsync(CancellationToken ct)
        {
            if (share is not null) await share.WaitAsync(ct);

            try
            {
                await all.WaitAsync(ct);
            }
            catch (OperationCanceledException)
            {
                share?.Release();
                throw;
            }

            _held = true;
        }

        public void Release()
        {
            if (!_held) return;

            _held = false;
            all.Release();
            share?.Release();
        }
    }

    // A template for each kind, so that each keeps what it names as values of their own — the rule
    // and the topic an alarm was for, the flow and the node a post was for — which a log read by a
    // machine filters on. Folded into one value they would make the same sentence and lose both.
    private void GiveUp(Delivery job, int attempts, string reason)
    {
        switch (job)
        {
            case AlertDelivery alert:
                _log.LogWarning(
                    "The webhook for {RuleName} on {Topic} was not delivered to {Url} after " +
                    "{Attempts} attempt(s): {Reason}",
                    alert.Alert.RuleName, alert.Alert.Topic, Redacted(job.Url), attempts, reason);
                break;

            case FlowDelivery flow:
                _log.LogWarning(
                    "The webhook for flow {Flow}'s node {Node} was not delivered to {Url} after " +
                    "{Attempts} attempt(s): {Reason}",
                    flow.Post.Run.FlowId, flow.Post.NodeId, Redacted(job.Url), attempts, reason);

                // The node's sentence is read by a person and not filtered on, so it says one attempt or
                // three as a person would, where the log's template has to say both at once.
                flow.Failed($"The webhook was not delivered after {attempts} {(attempts == 1 ? "attempt" : "attempts")}: {reason}.");
                break;
        }
    }

    private async Task<(bool Delivered, string Reason)> AttemptAsync(
        Delivery job, string body, CancellationToken budget)
    {
        // Two deadlines, and both of them are on the injected clock: this attempt's ten seconds,
        // and what is left of the delivery's twenty.
        using var timeout = new CancellationTokenSource(AttemptTimeout, _time);
        using var attempt = CancellationTokenSource.CreateLinkedTokenSource(timeout.Token, budget);

        using var request = new HttpRequestMessage(HttpMethod.Post, job.Url)
        {
            Content = new StringContent(body, Encoding.UTF8, job.ContentType)
        };

        // Without validation, because the user's header is the user's business — and a name that
        // belongs on the content rather than the request is refused here rather than throwing,
        // which is why nothing is asserted on the result.
        foreach (var (name, value) in job.Headers)
            request.Headers.TryAddWithoutValidation(name, value);

        try
        {
            // ResponseHeadersRead, and the response is disposed without a byte of it being read.
            // An endpoint that answers 200 and then streams for ever would otherwise hold one of
            // the four slots for bytes nothing here was ever going to look at.
            using var response = await _client.SendAsync(
                request, HttpCompletionOption.ResponseHeadersRead, attempt.Token);

            if (response.IsSuccessStatusCode) return (true, string.Empty);

            // A 3xx lands here with everything else, and that is the point: the handler does not
            // follow redirects, so a redirect is an endpoint that did not accept the alert. Said in
            // words, since a reason is read on a Webhook node as well as in the log, and a number
            // standing alone there is not a sentence anyone can act on.
            return (false, string.Create(CultureInfo.InvariantCulture, $"the receiver answered {(int)response.StatusCode}"));
        }
        catch (OperationCanceledException) when (budget.IsCancellationRequested)
        {
            return (false, "the 20 second budget for this webhook ran out");
        }
        catch (OperationCanceledException)
        {
            return (false, "no answer within 10 seconds");
        }
        catch (Exception ex)
        {
            // A refused connection, a name that does not resolve, a TLS handshake that failed.
            // All of them are one thing to this class: an attempt that did not land.
            return (false, ex.Message);
        }
    }
}
