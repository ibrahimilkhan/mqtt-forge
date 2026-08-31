using System.Globalization;
using System.Net.Http;
using System.Text;
using System.Threading.Channels;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using MqttForge.Application.Alerts;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;

namespace MqttForge.Infrastructure.Alerts;

/// <summary>
/// The alert, POSTed to an address the user gave. One bounded queue, one pump, four deliveries in
/// flight, and one at a time per endpoint.
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
public sealed class WebhookDispatcher : IAlertDispatcher, IHostedService
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

    /// <summary>How many times one alert is offered to one endpoint.</summary>
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

    private sealed record Delivery(Alert Alert, string Event, WebhookAction Action);

    private readonly HttpClient _client;
    private readonly AlertEngineOptions _options;
    private readonly ILogger<WebhookDispatcher> _log;
    private readonly AlertPanelCounters? _panel;
    private readonly TimeProvider _time;
    private readonly Channel<Delivery> _queue;
    private readonly SemaphoreSlim _slots = new(MaxInFlight, MaxInFlight);
    private readonly CancellationTokenSource _stopping = new();

    // One task per endpoint, each the tail of that endpoint's chain. Touched by the pump thread
    // and nothing else — the channel is SingleReader — so there is no lock on it.
    private readonly Dictionary<string, Task> _chains = new(StringComparer.Ordinal);

    private Task? _pump;
    private int _dropped;
    private int _pending;
    private int _saidWebhooksAreOff;

    /// <summary>Deliveries the queue had to discard. The panel's <c>webhooksDropped</c>.</summary>
    public int Dropped => Volatile.Read(ref _dropped);

    /// <summary>Deliveries queued or in flight. Read at shutdown to say what is being lost.</summary>
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
                _queue.Writer.TryWrite(new Delivery(alert, @event, webhook));
            }

        return Task.CompletedTask;
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

    private void OnDropped(Delivery job)
    {
        Interlocked.Decrement(ref _pending);
        Interlocked.Increment(ref _dropped);

        // The same drop, counted a second time where GET /api/alerts can read it. Dropped is this
        // class's own number and AlertPanelCounters is the panel's; they are one event, and the
        // controller cannot see this object. See AlertPanelCounters for why it is not on the
        // snapshot — the core is a pure function of messages and rules and has no idea a queue
        // out here overflowed.
        _panel?.WebhookDropped();
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
            // endpoint that is missing an alert is entitled to know it was this and not the
            // network. Whatever is still in flight goes with the process a moment from now.
            _log.LogWarning(
                "{Count} alert webhook(s) were still unsent when MQTTForge stopped.", Pending);
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

        // Every endpoint's chain, including what the drain just handed them. DeliverAsync never
        // throws, so this never does either.
        await Task.WhenAll([.. _chains.Values]);
    }

    /// <summary>Puts one delivery behind whatever its own endpoint is already doing.</summary>
    // One at a time per endpoint, four endpoints at a time. The spec's "cevap vermeyen uç nokta
    // yalnızca kendi sırasını tıkasın": an address that has stopped answering must hold up its
    // own queue and nobody else's, and a chain per endpoint says that without a thread per
    // endpoint or a lock anywhere.
    private void Chain(Delivery job)
    {
        var endpoint = EndpointOf(job.Action.Url);
        var previous = _chains.TryGetValue(endpoint, out var tail) ? tail : Task.CompletedTask;

        // Not ExecuteSynchronously: the continuation would then start on the pump thread and hold
        // it until the first real await, which is the one thread that must never wait for HTTP.
        _chains[endpoint] = previous
            .ContinueWith(_ => DeliverAsync(job), CancellationToken.None,
                          TaskContinuationOptions.None, TaskScheduler.Default)
            .Unwrap();

        Prune(endpoint);
    }

    // Endpoints, not deliveries, so this dictionary is small — but a rule set that names a
    // hundred hosts would still leave a hundred finished tasks in it for the life of the process.
    private void Prune(string keep)
    {
        List<string>? finished = null;

        foreach (var (endpoint, task) in _chains)
            if (task.IsCompleted && !string.Equals(endpoint, keep, StringComparison.Ordinal))
                (finished ??= []).Add(endpoint);

        if (finished is null) return;

        foreach (var endpoint in finished) _chains.Remove(endpoint);
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
        await _slots.WaitAsync();

        try
        {
            await PostAsync(job);
        }
        catch (Exception ex)
        {
            // Nothing escapes: this task is the pump's, and a delivery that threw here would take
            // its endpoint's whole chain with it.
            _log.LogError(ex, "A webhook delivery failed in a way nothing expected.");
        }
        finally
        {
            Interlocked.Decrement(ref _pending);
            _slots.Release();
        }
    }

    private async Task PostAsync(Delivery job)
    {
        // The whole life of this delivery, retries and waits included, ends at this instant.
        using var budget = new CancellationTokenSource(Budget, _time);

        var body = AlertPayload.For(job.Alert, job.Event);

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

            try
            {
                await Task.Delay(BackoffFor(attempt), _time, wait.Token);
            }
            catch (OperationCanceledException)
            {
                GiveUp(job, attempt,
                    budget.IsCancellationRequested
                        ? "the 20 second budget for this alert ran out"
                        : "MQTTForge is stopping");

                return;
            }
        }
    }

    private void GiveUp(Delivery job, int attempts, string reason) =>
        _log.LogWarning(
            "The webhook for {RuleName} on {Topic} was not delivered to {Url} after " +
            "{Attempts} attempt(s): {Reason}",
            job.Alert.RuleName, job.Alert.Topic, Redacted(job.Action.Url), attempts, reason);

    private async Task<(bool Delivered, string Reason)> AttemptAsync(
        Delivery job, string body, CancellationToken budget)
    {
        // Two deadlines, and both of them are on the injected clock: this attempt's ten seconds,
        // and what is left of the delivery's twenty.
        using var timeout = new CancellationTokenSource(AttemptTimeout, _time);
        using var attempt = CancellationTokenSource.CreateLinkedTokenSource(timeout.Token, budget);

        using var request = new HttpRequestMessage(HttpMethod.Post, job.Action.Url)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json")
        };

        // Without validation, because the user's header is the user's business — and a name that
        // belongs on the content rather than the request is refused here rather than throwing,
        // which is why nothing is asserted on the result.
        foreach (var (name, value) in job.Action.Headers)
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
            // follow redirects, so a redirect is an endpoint that did not accept the alert.
            return (false, ((int)response.StatusCode).ToString(CultureInfo.InvariantCulture));
        }
        catch (OperationCanceledException) when (budget.IsCancellationRequested)
        {
            return (false, "the 20 second budget for this alert ran out");
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
