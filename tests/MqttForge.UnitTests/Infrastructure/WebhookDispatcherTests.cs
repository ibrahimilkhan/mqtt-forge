using System.Net;
using System.Net.Http;
using System.Text;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;
using MqttForge.Application.Alerts;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Alerts;
using MqttForge.UnitTests.Application.Alerts;
using Xunit;

namespace MqttForge.UnitTests.Infrastructure;

/// <summary>
/// The one channel that leaves the machine, and the only one that can be slow.
///
/// Everything here runs against a stubbed <see cref="HttpMessageHandler"/> and a
/// <see cref="FakeTimeProvider"/>. No socket is opened, no port is listened on, and no test in
/// this file waits on wall-clock time for a retry: the spec's "test sunucusu diye bir adres yok".
/// A test that opened a real connection would be a test that fails on a build machine with no
/// network and passes on the author's laptop.
/// </summary>
// The awkward part of these tests is the fake clock, and it is worth saying why the helpers below
// look the way they do. FakeTimeProvider only fires timers that already exist when the clock is
// pushed, so a test that advances a second the instant it sees a failed request can advance past
// a Task.Delay the dispatcher has not registered yet — and then nothing ever fires. AdvanceUntil
// moves in tenth-of-a-second steps with a real pause before each one, and reports how much fake
// time it took; the assertions are ranges one step wide because of exactly that.
public class WebhookDispatcherTests : IAsyncLifetime
{
    private static readonly DateTimeOffset T0 = new(2026, 8, 30, 9, 0, 0, TimeSpan.Zero);

    private const string EndpointA = "http://a.example/hook";
    private const string EndpointB = "http://b.example/hook";

    private readonly FakeTimeProvider _time = new(T0);
    private readonly RecordingLogger<WebhookDispatcher> _log = new();

    private readonly TaskCompletionSource<bool> _gateA =
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private readonly TaskCompletionSource<bool> _gateB =
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private StubHandler? _handler;
    private WebhookDispatcher? _sut;

    public Task InitializeAsync() => Task.CompletedTask;

    // Every gate released and the pump stopped, whatever the test did. The real-time token is the
    // point: StopAsync waits out its drain budget on the fake clock, which a finished test is
    // never going to move again, so the token is the only thing that can end that wait.
    public async Task DisposeAsync()
    {
        _gateA.TrySetResult(true);
        _gateB.TrySetResult(true);

        if (_sut is null) return;

        using var patience = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await _sut.StopAsync(patience.Token);
    }

    // The clock is fourth and the panel fifth, which is the order the constructor is written in
    // and the reason it is written that way: a counter slipped in before the TimeProvider would
    // bind this call's FakeTimeProvider to an AlertPanelCounters and take the whole file with it.
    private WebhookDispatcher Build(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> answer,
        bool allowWebhooks = true,
        AlertPanelCounters? panel = null)
    {
        _handler = new StubHandler(answer);
        _sut = new WebhookDispatcher(
            new HttpClient(_handler, disposeHandler: false),
            new AlertEngineOptions { AllowWebhooks = allowWebhooks },
            _log,
            _time,
            panel);

        return _sut;
    }

    private async Task<WebhookDispatcher> Started(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> answer,
        bool allowWebhooks = true)
    {
        var sut = Build(answer, allowWebhooks);
        await sut.StartAsync(CancellationToken.None);

        return sut;
    }

    private StubHandler Handler => _handler ?? throw new InvalidOperationException("Build first.");

    private static Task<HttpResponseMessage> Status(HttpStatusCode code) =>
        Task.FromResult(new HttpResponseMessage(code));

    private static Alert Fired(
        string url,
        string @event = "raised",
        IReadOnlyDictionary<string, string>? headers = null,
        string id = "a1",
        IReadOnlyList<AlertAction>? actions = null) =>
        new(id, "r1", "Boiler temperature", "plant/boiler/temp", AlertSeverity.Critical,
            FiredAt: T0, LastSeenAt: T0,
            ResolvedAt: @event == "resolved" ? T0 : null,
            ResolvedBy: @event == "resolved" ? "clear" : null,
            MutedUntil: null, Count: 1, Reason: "94.2 > 90", Value: 94.2,
            Sample: "{\"temp\":94.2}",
            Actions: actions ?? [new WebhookAction(url, headers ?? new Dictionary<string, string>())]);

    /// <summary>Waits, in real time only, for something the pump does without the clock moving.</summary>
    private static async Task Settle(Func<bool> until, string what)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(10);

        while (DateTime.UtcNow < deadline)
        {
            if (until()) return;

            await Task.Delay(5);
        }

        Assert.Fail($"Timed out waiting until {what}.");
    }

    /// <summary>Moves the fake clock until the condition holds, and says how far it had to move.</summary>
    private async Task<TimeSpan> AdvanceUntil(Func<bool> until, string what)
    {
        var step = TimeSpan.FromMilliseconds(100);
        var moved = TimeSpan.Zero;
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(30);

        while (DateTime.UtcNow < deadline)
        {
            if (until()) return moved;

            // The real pause comes first, so the dispatcher has reached its Task.Delay and
            // registered the timer before the step that is meant to fire it.
            await Task.Delay(5);
            _time.Advance(step);
            moved += step;
        }

        Assert.Fail($"Timed out waiting until {what}.");

        return moved;
    }

    [Fact]
    public async Task A_delivered_webhook_is_one_post_carrying_the_shared_body()
    {
        var sut = await Started((_, _) => Status(HttpStatusCode.OK));
        var alert = Fired(EndpointA);

        await sut.RaisedAsync([alert]);
        await Settle(() => Handler.Sent.Count > 0, "the webhook was sent");

        var sent = Assert.Single(Handler.Sent);
        Assert.Equal(HttpMethod.Post, sent.Method);
        Assert.Equal(EndpointA, sent.Url.ToString());
        Assert.Equal(AlertPayload.For(alert, "raised"), sent.Body);
    }

    // The same channel, the other half of the pair. An endpoint that is told an alarm started and
    // never told it stopped is worse than one that was never told anything.
    [Fact]
    public async Task A_resolved_alert_is_sent_with_the_resolved_body()
    {
        var sut = await Started((_, _) => Status(HttpStatusCode.OK));
        var alert = Fired(EndpointA, "resolved");

        await sut.ResolvedAsync([alert]);
        await Settle(() => Handler.Sent.Count > 0, "the webhook was sent");

        Assert.Equal(AlertPayload.For(alert, "resolved"), Assert.Single(Handler.Sent).Body);
    }

    // The user's own headers are the whole reason webhooks are useful here: a Home Assistant
    // token, an ngrok bypass, a shared secret the receiving end checks.
    [Fact]
    public async Task The_headers_the_rule_carries_go_out_with_the_request()
    {
        var sut = await Started((_, _) => Status(HttpStatusCode.OK));

        await sut.RaisedAsync([Fired(EndpointA,
            headers: new Dictionary<string, string> { ["Authorization"] = "Bearer sekrit" })]);

        await Settle(() => Handler.Sent.Count > 0, "the webhook was sent");
        Assert.Equal("Bearer sekrit", Assert.Single(Handler.Sent).Headers["Authorization"]);
    }

    // The spec says the response body is not read, and it is not a preference: a receiving end
    // that answers 200 and then streams for ever would otherwise hold a slot until the attempt
    // deadline, for bytes nothing in this process was ever going to look at.
    [Fact]
    public async Task The_response_body_is_never_read()
    {
        var spy = new SpyStream("a body nobody wants"u8.ToArray());
        var sut = await Started((_, _) => Task.FromResult(
            new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(spy) }));

        await sut.RaisedAsync([Fired(EndpointA)]);
        await Settle(() => Handler.Sent.Count > 0, "the webhook was sent");

        // A moment for a buffering read to have happened if one were going to.
        await Task.Delay(50);
        Assert.False(spy.WasRead);
    }

    [Fact]
    public async Task A_five_hundred_is_tried_three_times()
    {
        var sut = await Started((_, _) => Status(HttpStatusCode.InternalServerError));

        await sut.RaisedAsync([Fired(EndpointA)]);
        await AdvanceUntil(() => Handler.Sent.Count >= 3, "the third attempt was made");

        // And no fourth, however long the clock runs.
        await AdvanceUntil(() => _log.Lines.Any(l => l.Message.Contains("not delivered")),
            "the dispatcher gave up");

        Assert.Equal(3, Handler.Sent.Count);
    }

    [Fact]
    public async Task The_gap_before_the_second_attempt_is_one_second()
    {
        var sut = await Started((_, _) => Status(HttpStatusCode.InternalServerError));

        await sut.RaisedAsync([Fired(EndpointA)]);
        await Settle(() => Handler.Sent.Count >= 1, "the first attempt was made");

        var waited = await AdvanceUntil(() => Handler.Sent.Count >= 2, "the second attempt was made");

        Assert.InRange(waited.TotalSeconds, 0.9, 1.5);
    }

    [Fact]
    public async Task The_gap_before_the_third_attempt_is_two_seconds()
    {
        var sut = await Started((_, _) => Status(HttpStatusCode.InternalServerError));

        await sut.RaisedAsync([Fired(EndpointA)]);
        await AdvanceUntil(() => Handler.Sent.Count >= 2, "the second attempt was made");

        var waited = await AdvanceUntil(() => Handler.Sent.Count >= 3, "the third attempt was made");

        Assert.InRange(waited.TotalSeconds, 1.9, 2.6);
    }

    // The rung three attempts never reach. Pinned as arithmetic rather than left in a comment,
    // because the day MaxAttempts moves is the day this wait matters.
    [Fact]
    public void The_backoff_ladder_doubles()
    {
        Assert.Equal(TimeSpan.FromSeconds(1), WebhookDispatcher.BackoffFor(1));
        Assert.Equal(TimeSpan.FromSeconds(2), WebhookDispatcher.BackoffFor(2));
        Assert.Equal(TimeSpan.FromSeconds(4), WebhookDispatcher.BackoffFor(3));
    }

    // A redirect is a failure, and the reason is in SECURITY.md rather than in HTTP: following one
    // would carry the Authorization header the user wrote for their own host to a host they never
    // named, chosen by whoever answered the first request.
    [Fact]
    public async Task A_redirect_is_a_failure_and_the_dispatcher_does_not_chase_it()
    {
        var sut = await Started((_, _) =>
        {
            var response = new HttpResponseMessage(HttpStatusCode.Found);
            response.Headers.Location = new Uri("http://elsewhere.example/collect");

            return Task.FromResult(response);
        });

        await sut.RaisedAsync([Fired(EndpointA)]);
        await AdvanceUntil(() => _log.Lines.Any(l => l.Message.Contains("not delivered")),
            "the dispatcher gave up");

        // Retried, so it was judged a failure; and every one of those attempts went to the
        // address the rule named, so Location was never read.
        Assert.Equal(3, Handler.Sent.Count);
        Assert.All(Handler.Sent, sent => Assert.Equal(EndpointA, sent.Url.ToString()));
        Assert.Contains(_log.Lines, l => l.Message.Contains("302"));
    }

    // The stub cannot follow a redirect on the dispatcher's behalf, so the test above pins our
    // half and this one pins the handler the wiring is told to build. Neither of them can see the
    // container, which is why the wiring task carries its own test that the dispatcher it resolves
    // was built from this handler and not from the bare HttpClient AddHttpClient also registers.
    [Fact]
    public void The_client_the_wiring_builds_is_named_and_does_not_follow_redirects()
    {
        Assert.Equal("alert-webhook", WebhookDispatcher.ClientName);

        using var handler = WebhookDispatcher.CreateHandler();
        Assert.False(handler.AllowAutoRedirect);
    }

    // Three attempts of ten seconds plus the waits is thirty-three seconds at the head of a queue
    // one endpoint is entitled to hold. The budget is what stops one dead address delaying the
    // alerts of every other.
    [Fact]
    public async Task The_budget_cuts_off_an_endpoint_that_never_answers()
    {
        var sut = await Started(async (_, ct) =>
        {
            await Task.Delay(Timeout.Infinite, ct);

            return new HttpResponseMessage(HttpStatusCode.OK);
        });

        await sut.RaisedAsync([Fired(EndpointA)]);
        await AdvanceUntil(() => _log.Lines.Any(l => l.Message.Contains("budget")),
            "the budget ran out");

        // Ten seconds for the first attempt, one second of backoff, and the second attempt is cut
        // off by the twenty-second budget before its own ten seconds are up. There is no third.
        Assert.Equal(2, Handler.Sent.Count);
    }

    // DropWrite, not DropOldest, and this is the one place this class deliberately differs from
    // SignalRMessageNotifier: an item at the front of this queue may already be halfway through
    // an attempt, and discarding it would mean an endpoint receiving half a POST and no record of
    // why. The newest goes instead, and the count is what the panel shows.
    [Fact]
    public async Task A_full_queue_drops_the_newest_and_counts_them()
    {
        // Deliberately never started: with no pump there is nothing draining, so the queue fills
        // exactly as far as its capacity and not one item further.
        var sut = Build((_, _) => Status(HttpStatusCode.OK));

        var alerts = new List<Alert>();
        for (var i = 0; i < WebhookDispatcher.QueueCapacity + 76; i++)
            alerts.Add(Fired(EndpointA, id: $"a{i}"));

        await sut.RaisedAsync(alerts);

        Assert.Equal(76, sut.Dropped);
        Assert.Equal(WebhookDispatcher.QueueCapacity, sut.Pending);
    }

    // The same drops, counted a second time where the endpoint can read them. Dropped is this
    // class's own number and AlertPanelCounters.WebhooksDropped is the panel's, and they are one
    // event: GET /api/alerts cannot see this object, and a version that moved one without moving
    // the other would print a confident zero on a panel while the queue was overflowing.
    [Fact]
    public async Task A_dropped_delivery_is_counted_on_the_panel_as_well()
    {
        var panel = new AlertPanelCounters();
        var sut = Build((_, _) => Status(HttpStatusCode.OK), panel: panel);

        var alerts = new List<Alert>();
        for (var i = 0; i < WebhookDispatcher.QueueCapacity + 3; i++)
            alerts.Add(Fired(EndpointA, id: $"a{i}"));

        await sut.RaisedAsync(alerts);

        Assert.Equal(3, sut.Dropped);
        Assert.Equal(3, panel.WebhooksDropped);
    }

    [Fact]
    public async Task Two_alerts_for_one_endpoint_are_sent_one_after_the_other()
    {
        var sut = await Started(async (_, _) =>
        {
            await _gateA.Task;

            return new HttpResponseMessage(HttpStatusCode.OK);
        });

        await sut.RaisedAsync([Fired(EndpointA, id: "a1"), Fired(EndpointA, id: "a2")]);
        await Settle(() => Handler.Sent.Count >= 1, "the first request was made");

        // The second is behind the first, not beside it. A moment to be sure.
        await Task.Delay(50);
        Assert.Single(Handler.Sent);

        _gateA.TrySetResult(true);
        await Settle(() => Handler.Sent.Count >= 2, "the second request was made");
    }

    // The other half of the same bargain: one endpoint that has stopped answering must hold up
    // its own queue and nobody else's.
    [Fact]
    public async Task Two_endpoints_are_sent_at_the_same_time()
    {
        var sut = await Started(async (request, _) =>
        {
            await (request.RequestUri!.Host == "a.example" ? _gateA.Task : _gateB.Task);

            return new HttpResponseMessage(HttpStatusCode.OK);
        });

        await sut.RaisedAsync([Fired(EndpointA, id: "a1"), Fired(EndpointB, id: "a2")]);

        // Neither has answered, and both are in flight.
        await Settle(() => Handler.Sent.Count >= 2, "both requests were made");
    }

    // Shutdown is a budget, not a cancellation. Whatever is queued gets one honest attempt each,
    // because the alternative is a container restart silently eating the alarm that prompted it.
    [Fact]
    public async Task Shutdown_gives_what_is_queued_one_attempt_each()
    {
        var sut = await Started((_, _) => Status(HttpStatusCode.InternalServerError));

        await sut.RaisedAsync([
            Fired(EndpointA, id: "a1"),
            Fired(EndpointB, id: "a2")
        ]);

        // Both have failed once and are sitting in their backoff waits, which the clock is never
        // going to reach: stopping is what ends them.
        await Settle(() => Handler.Sent.Count >= 2, "both first attempts were made");

        using var patience = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await sut.StopAsync(patience.Token);

        // One each. A stop that let the ladder run would have made four requests or hung.
        Assert.Equal(2, Handler.Sent.Count);
        Assert.Contains(_log.Lines, l => l.Message.Contains("stopping"));
    }

    // And what did not fit is said out loud. A channel that fails silently is worse than one that
    // does not exist — this file's own measure, applied to its own last four seconds.
    [Fact]
    public async Task Shutdown_says_what_it_could_not_send()
    {
        var sut = await Started(async (_, _) =>
        {
            await _gateA.Task;

            return new HttpResponseMessage(HttpStatusCode.OK);
        });

        await sut.RaisedAsync([Fired(EndpointA)]);
        await Settle(() => Handler.Sent.Count >= 1, "the request was made");

        var stopping = Task.Run(() => sut.StopAsync(CancellationToken.None));

        await AdvanceUntil(() => _log.Lines.Any(l => l.Message.Contains("still unsent")),
            "the drain budget ran out");

        _gateA.TrySetResult(true);
        await stopping;
    }

    [Fact]
    public async Task Webhooks_turned_off_send_nothing()
    {
        var sut = await Started((_, _) => Status(HttpStatusCode.OK), allowWebhooks: false);

        await sut.RaisedAsync([Fired(EndpointA)]);

        await Task.Delay(50);
        Assert.Empty(Handler.Sent);
        Assert.Equal(0, sut.Pending);
    }

    // Once, not once per alert. A switch an operator turned on purpose is a fact about the
    // configuration, and a line per alarm would bury the alarms in it.
    [Fact]
    public async Task Webhooks_turned_off_are_said_once()
    {
        var sut = await Started((_, _) => Status(HttpStatusCode.OK), allowWebhooks: false);

        await sut.RaisedAsync([Fired(EndpointA, id: "a1")]);
        await sut.RaisedAsync([Fired(EndpointB, id: "a2")]);
        await sut.ResolvedAsync([Fired(EndpointA, "resolved", id: "a1")]);

        Assert.Single(_log.Lines, l => l.Message.Contains("AllowWebhooks"));
    }

    // An alert that asked for a screen notice and nothing else has no business here at all.
    [Fact]
    public async Task An_alert_with_no_webhook_action_sends_nothing()
    {
        var sut = await Started((_, _) => Status(HttpStatusCode.OK));

        await sut.RaisedAsync([Fired(EndpointA, actions: [new ScreenAction(), new SoundAction()])]);

        await Task.Delay(50);
        Assert.Empty(Handler.Sent);
    }

    private sealed record Sent(
        HttpMethod Method, Uri Url, IReadOnlyDictionary<string, string> Headers, string Body);

    private sealed class StubHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> _answer;
        private readonly Lock _gate = new();
        private readonly List<Sent> _sent = [];

        public StubHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> answer) =>
            _answer = answer;

        public IReadOnlyList<Sent> Sent
        {
            get { lock (_gate) return [.. _sent]; }
        }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = request.Content is null
                ? string.Empty
                : await request.Content.ReadAsStringAsync(cancellationToken);

            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var header in request.Headers)
                headers[header.Key] = string.Join(", ", header.Value);

            // Recorded before the answer, so a request that is about to block for ever is still a
            // request this test can see.
            lock (_gate) _sent.Add(new Sent(request.Method, request.RequestUri!, headers, body));

            return await _answer(request, cancellationToken);
        }
    }

    /// <summary>A response body that says whether anybody read it.</summary>
    private sealed class SpyStream : MemoryStream
    {
        public SpyStream(byte[] bytes) : base(bytes) { }

        public bool WasRead { get; private set; }

        public override int Read(byte[] buffer, int offset, int count)
        {
            WasRead = true;

            return base.Read(buffer, offset, count);
        }

        public override ValueTask<int> ReadAsync(
            Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            WasRead = true;

            return base.ReadAsync(buffer, cancellationToken);
        }
    }
}
