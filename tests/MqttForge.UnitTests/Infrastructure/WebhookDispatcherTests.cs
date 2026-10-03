using System.Collections.Concurrent;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Text;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;
using MqttForge.Application.Alerts;
using MqttForge.Application.Flows;
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

    /// <summary>A Webhook node's post, as the flow engine hands it over.</summary>
    private static FlowWebhookPost Posting(
        string url = EndpointA, string body = "hot", string contentType = "text/plain") =>
        new(new FlowRunKey("f1", FlowRunKind.Active), 1, "hook", url, body, contentType);

    // As many hosts as it takes to fill the flows' cap, since one host is held to FlowPostsPerEndpoint of their
    // posts: eight.
    private const int Hosts = WebhookDispatcher.FlowPostsWaiting / WebhookDispatcher.FlowPostsPerEndpoint;

    /// <summary>The <paramref name="i"/>th of the posts that fill the flows' cap, to each of the hosts in turn.</summary>
    private static FlowWebhookPost Filling(int i) => Posting($"http://h{i % Hosts}.example/hook");

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

        // Said here as well because the content type is a delivery's own now, and an alert's is the one
        // place a flow's text/plain must not have leaked into.
        Assert.Equal("application/json", sent.ContentType);
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

    // The line a rule's alarm is given up on with names the rule and the topic as values of their own, which
    // is what a log read by a machine rather than a person filters on. A template that folded them into one
    // would make the same sentence and lose both, so it is the values that are pinned here as well as the text.
    [Fact]
    public async Task An_alarm_given_up_on_is_logged_with_its_rule_and_its_topic_as_values_of_their_own()
    {
        var sut = await Started((_, _) => Status(HttpStatusCode.InternalServerError));

        await sut.RaisedAsync([Fired(EndpointA)]);
        await AdvanceUntil(() => _log.Lines.Any(l => l.Message.Contains("not delivered")),
            "the dispatcher gave up");

        var line = Assert.Single(_log.Lines, l => l.Message.Contains("not delivered"));
        Assert.Equal(
            $"The webhook for Boiler temperature on plant/boiler/temp was not delivered to {EndpointA} after 3 attempt(s): " +
            "the receiver answered 500",
            line.Message);
        Assert.Equal("Boiler temperature", line.Values["RuleName"]);
        Assert.Equal("plant/boiler/temp", line.Values["Topic"]);
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

    // Every delivery still waiting is counted, a flow's posts among them, so what is said is deliveries and
    // not alerts: an operator reading "alert webhooks" goes looking for an alarm that was never raised. And
    // the number comes after the sentence rather than inside it, so that the line reads right at one as it
    // does at a thousand, and it is still a value of its own for a log that a machine reads.
    [Fact]
    public async Task Shutdown_counts_a_flows_post_among_what_it_could_not_send()
    {
        var sut = await Started(async (_, _) =>
        {
            await _gateA.Task;

            return new HttpResponseMessage(HttpStatusCode.OK);
        });

        Assert.True(sut.Post(Posting(), _ => { }));
        await Settle(() => Handler.Sent.Count >= 1, "the post was made");

        var stopping = Task.Run(() => sut.StopAsync(CancellationToken.None));

        await AdvanceUntil(() => _log.Lines.Any(l => l.Message.Contains("still unsent")),
            "the drain budget ran out");

        var line = Assert.Single(_log.Lines, l => l.Message.Contains("still unsent"));
        Assert.Equal("Webhook deliveries still unsent when MQTTForge stopped: 1", line.Message);
        Assert.Equal(1, Assert.IsType<int>(line.Values["Count"]));

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

    // ---- a Webhook node's post ----
    //
    // The second kind of delivery. It is the same queue, client, attempts and budget as an alert's, so
    // what these cases pin is where it has to come out the same — the switch, the redirect rule, the
    // counts — and where it must not. The body and its kind of content are the node's, and an alert's are
    // made from the alert. And the flows' posts are capped, wait in lines of their own and may hold only
    // half the slots, because a flow can ask for one every second for as long as it runs, and a rule's
    // alarm must not wait behind them.

    [Fact]
    public async Task A_flows_post_goes_with_its_own_body_and_content_type()
    {
        var sut = await Started((_, _) => Status(HttpStatusCode.OK));

        Assert.True(sut.Post(Posting(body: "hot", contentType: "text/plain"), _ => { }));
        await Settle(() => Handler.Sent.Count > 0, "the post was sent");

        var sent = Assert.Single(Handler.Sent);
        Assert.Equal(HttpMethod.Post, sent.Method);
        Assert.Equal(EndpointA, sent.Url.ToString());
        Assert.Equal("hot", sent.Body);
        Assert.Equal("text/plain", sent.ContentType);

        // A rule's headers are the rule's. A Webhook node has none to give, and nothing of an alert's goes
        // with its post.
        Assert.Empty(sent.Headers);
    }

    // Told once, and only when the ladder is spent. The engine counts what it is told as one failed step
    // on the node, so a callback at the first refusal would count an attempt that the next one puts right,
    // and one for every attempt would count a single post three times.
    [Fact]
    public async Task A_flows_post_that_never_lands_is_said_back_once_with_its_reason()
    {
        var sut = await Started((_, _) => Status(HttpStatusCode.InternalServerError));
        var said = new ConcurrentQueue<string>();

        Assert.True(sut.Post(Posting(), said.Enqueue));

        // The second attempt is only made once the first has been judged a failure and a retry decided on.
        await AdvanceUntil(() => Handler.Sent.Count >= 2, "the second attempt was made");
        Assert.Empty(said);

        await AdvanceUntil(() => !said.IsEmpty, "the post was given up on");
        await Task.Delay(50);

        Assert.Equal(3, Handler.Sent.Count);
        Assert.Equal("The webhook was not delivered after 3 attempts: the receiver answered 500.", Assert.Single(said));

        // Named in the log as a flow's node, with the flow and the node as values of their own, as a rule's
        // alarm is named by its rule and its topic.
        var line = Assert.Single(_log.Lines, l => l.Message.Contains("not delivered"));
        Assert.Equal(
            $"The webhook for flow f1's node hook was not delivered to {EndpointA} after 3 attempt(s): the receiver answered 500",
            line.Message);
        Assert.Equal("f1", line.Values["Flow"]);
        Assert.Equal("hook", line.Values["Node"]);
    }

    // The sentence stands on the node, so one attempt is said as one: given up on at its first wait, because
    // the host is stopping.
    [Fact]
    public async Task A_flows_post_given_up_on_after_one_attempt_says_one_attempt()
    {
        var sut = await Started((_, _) => Status(HttpStatusCode.InternalServerError));
        var said = new ConcurrentQueue<string>();

        Assert.True(sut.Post(Posting(), said.Enqueue));
        await Settle(() => Handler.Sent.Count == 1, "the first attempt to be made");

        using var patience = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await sut.StopAsync(patience.Token);

        Assert.Equal("The webhook was not delivered after 1 attempt: MQTTForge is stopping.", Assert.Single(said));
    }

    // A delivery gives its slots back while it waits between two attempts, and takes them again after. Held
    // through the waits, two receivers answering errors kept their slots for most of each delivery's life, and
    // whatever was going to a host that answers waited behind them: measured, most of a healthy host's posts
    // were refused while two receivers failed. The clock is held still once the four first attempts are made,
    // so none of those waits ends and nothing is given up on: the delivery to the healthy host can only go out
    // in a slot one of them gave back.
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task While_two_receivers_answer_errors_a_delivery_to_another_host_goes_out_between_their_attempts(bool flows)
    {
        var sut = await Started((request, _) =>
            Status(request.RequestUri!.Host == "healthy.example" ? HttpStatusCode.OK : HttpStatusCode.InternalServerError));

        // Each failing receiver is sent a rule's alarm and a flow's post, which wait in lines of their own: four
        // deliveries, which between them hold all four slots, and the flows' two, while they make their attempts.
        foreach (var host in new[] { "h1", "h2" })
        {
            await sut.RaisedAsync([Fired($"http://{host}.example/hook", id: host)]);
            Assert.True(sut.Post(Posting($"http://{host}.example/hook"), _ => { }));
        }

        await Settle(() => Handler.Sent.Count == 4, "each failing delivery to have made its first attempt");

        if (flows) Assert.True(sut.Post(Posting("http://healthy.example/hook"), _ => { }));
        else await sut.RaisedAsync([Fired("http://healthy.example/hook", id: "healthy")]);

        await Settle(() => Handler.Sent.Any(sent => sent.Url.Host == "healthy.example"),
            "the delivery to the healthy host to go out while the failing ones wait to try again");
        Assert.Equal(5, Handler.Sent.Count);
    }

    // The queue does not hold the flows' posts back while the pump runs: it moves each one on into its
    // endpoint's chain the moment it arrives, so the queue is empty again at once, and a chain waits for as
    // long as its host does. A flow can ask for a post every second from every Webhook node it has, for as
    // long as it runs, so their posts are counted from Post to the end of their last attempt, and past the cap
    // the newest is refused: answered false, which the engine counts on the node that asked, and counted as
    // dropped where the panel can see it. The posts go to eight hosts, because one host is held to
    // FlowPostsPerEndpoint of them, and it takes eight that do not answer to fill the cap.
    [Fact]
    public async Task A_flows_posts_past_their_cap_are_refused_while_their_hosts_do_not_answer()
    {
        var panel = new AlertPanelCounters();
        var sut = Build(async (_, _) =>
        {
            await _gateA.Task;

            return new HttpResponseMessage(HttpStatusCode.OK);
        }, panel: panel);
        await sut.StartAsync(CancellationToken.None);

        for (var i = 0; i < WebhookDispatcher.FlowPostsWaiting; i++)
            Assert.True(sut.Post(Filling(i), _ => { }));

        await Settle(() => Handler.Sent.Count == WebhookDispatcher.FlowsInFlight, "the first posts to be on their way");

        // The cap bounds what the flows' posts hold between them, so past it a post is refused wherever it
        // goes: to one of the eight hosts, and to a ninth that has none of them waiting as well.
        Assert.False(sut.Post(Filling(WebhookDispatcher.FlowPostsWaiting), _ => { }));
        Assert.False(sut.Post(Posting("http://ninth.example/hook"), _ => { }));

        Assert.Equal(WebhookDispatcher.FlowPostsWaiting, sut.Pending);
        Assert.Equal(2, sut.Dropped);
        Assert.Equal(2, panel.WebhooksDropped);

        // And every post that ends gives its place back: the hosts answer, and the next post is taken.
        _gateA.TrySetResult(true);
        await Settle(() => sut.Pending == 0, "every post to have been delivered");

        Assert.True(sut.Post(Posting(), _ => { }));
    }

    // The queue's DropWrite lets the newest go and still answers that it was written, so the post that was
    // one too many has to be told apart from the ones that were taken: the engine counts a refusal on the
    // node that asked, and a post it was told was queued is a post nobody would ever account for. The queue
    // is filled with a rule's alarms, because the flows' own posts stop at their cap long before it is full.
    [Fact]
    public async Task A_flows_post_past_a_full_queue_is_refused_and_holds_no_place_under_their_caps()
    {
        // Not started yet, as the DropWrite test above has it: with nothing draining, the queue fills as far
        // as its capacity and not one item further. The alarms' host answers, and the flows' hosts do not.
        var panel = new AlertPanelCounters();
        var sut = Build(async (request, _) =>
        {
            if (request.RequestUri!.Host != "b.example") await _gateA.Task;

            return new HttpResponseMessage(HttpStatusCode.OK);
        }, panel: panel);
        var said = new ConcurrentQueue<string>();

        var alerts = new List<Alert>();
        for (var i = 0; i < WebhookDispatcher.QueueCapacity; i++)
            alerts.Add(Fired(EndpointB, id: $"a{i}"));

        await sut.RaisedAsync(alerts);

        Assert.False(sut.Post(Filling(0), said.Enqueue));

        // Counted where the alerts that do not fit are counted, once, and no longer waiting.
        Assert.Equal(1, sut.Dropped);
        Assert.Equal(1, panel.WebhooksDropped);
        Assert.Equal(WebhookDispatcher.QueueCapacity, sut.Pending);

        // And not told as well. A refusal is answered by the false, and a callback on top of it would be
        // the same post counted on its node twice.
        Assert.Empty(said);

        // Nor left counted against the flows' caps, in all or at its own host. With the alarms sent and the
        // queue empty, as many posts are taken as ever, as many to its host as to each of the others, and it is
        // the one past the cap that is refused.
        await sut.StartAsync(CancellationToken.None);
        await Settle(() => sut.Pending == 0, "the alarms to have been sent");

        for (var i = 0; i < WebhookDispatcher.FlowPostsWaiting; i++)
            Assert.True(sut.Post(Filling(i), said.Enqueue));

        Assert.False(sut.Post(Filling(WebhookDispatcher.FlowPostsWaiting), said.Enqueue));
    }

    // One host that has stopped answering holds up its own posts and nobody else's. Each post to it is given
    // its attempts in turn, and a Webhook node asks again every second, so counted with every other host's its
    // posts would fill the cap in two or three minutes: from then on every flow's posts, to every host, would
    // be refused, and counted on nodes that had done nothing wrong. So it is held to FlowPostsPerEndpoint of
    // them, and the next post to it is refused while a post to a host that answers is taken.
    [Fact]
    public async Task Flow_posts_stuck_at_one_host_leave_a_post_to_another_host_taken()
    {
        var panel = new AlertPanelCounters();
        var sut = Build(async (request, _) =>
        {
            if (request.RequestUri!.Host == "a.example") await _gateA.Task;

            return new HttpResponseMessage(HttpStatusCode.OK);
        }, panel: panel);
        await sut.StartAsync(CancellationToken.None);

        for (var i = 0; i < WebhookDispatcher.FlowPostsPerEndpoint; i++)
            Assert.True(sut.Post(Posting(EndpointA), _ => { }));

        // One more to the same host is refused, and counted where the panel can see it.
        Assert.False(sut.Post(Posting(EndpointA), _ => { }));
        Assert.Equal(1, sut.Dropped);
        Assert.Equal(1, panel.WebhooksDropped);

        // One to another host is taken, and goes out while they wait.
        Assert.True(sut.Post(Posting(EndpointB), _ => { }));
        await Settle(() => Handler.Sent.Any(sent => sent.Url.Host == "b.example"), "the post to the other host to be sent");

        // And the stuck host's places come back as its posts end: it answers, and the next post to it is taken.
        _gateA.TrySetResult(true);
        await Settle(() => sut.Pending == 0, "every post to have been delivered");

        Assert.True(sut.Post(Posting(EndpointA), _ => { }));
    }

    // An endpoint is counted only while the flows' posts to it are waiting. Left in at nought, it would stay
    // for every address a flow, or a Test of one, ever posted to, for as long as the process runs.
    [Fact]
    public async Task An_endpoint_is_no_longer_counted_once_its_last_post_has_ended()
    {
        var sut = await Started((_, _) => Status(HttpStatusCode.OK));

        foreach (var host in new[] { "h1", "h2", "h3" })
            Assert.True(sut.Post(Posting($"http://{host}.example/hook"), _ => { }));

        await Settle(() => sut.Pending == 0, "every post to have been delivered");

        Assert.Empty(FlowPostsAt(sut));
    }

    // A rule's alarms and a flow's posts to one host wait in lines of their own. In one line, a flow posting
    // every second to a host that has stopped answering would put a rule's alarm to the same host behind every
    // post it had made, each with twenty seconds to fail in.
    [Fact]
    public async Task An_alarm_to_a_host_the_flows_posts_are_stuck_on_is_still_sent()
    {
        var sut = await Started(async (request, _) =>
        {
            if (request.RequestUri!.AbsolutePath == "/flow") await _gateA.Task;

            return new HttpResponseMessage(HttpStatusCode.OK);
        });

        Assert.True(sut.Post(Posting("http://a.example/flow"), _ => { }));
        Assert.True(sut.Post(Posting("http://a.example/flow"), _ => { }));
        await Settle(() => Handler.Sent.Count == 1, "the first post to be on its way");

        await sut.RaisedAsync([Fired("http://a.example/alarm")]);

        await Settle(() => Handler.Sent.Any(sent => sent.Url.AbsolutePath == "/alarm"), "the alarm to be sent");
    }

    // And they share the four slots unequally: the flows' posts may hold two of them and no more, so however
    // many hosts those are waiting on, a rule's alarm has two to go out on.
    [Fact]
    public async Task Flow_posts_stuck_at_four_hosts_leave_a_slot_for_an_alarm()
    {
        var sut = await Started(async (request, _) =>
        {
            if (request.RequestUri!.Host != "alarms.example") await _gateA.Task;

            return new HttpResponseMessage(HttpStatusCode.OK);
        });

        foreach (var host in new[] { "h1", "h2", "h3", "h4" })
            Assert.True(sut.Post(Posting($"http://{host}.example/hook"), _ => { }));

        await Settle(() => Handler.Sent.Count >= WebhookDispatcher.FlowsInFlight, "the flows' posts to take their slots");

        await sut.RaisedAsync([Fired("http://alarms.example/hook")]);

        await Settle(() => Handler.Sent.Any(sent => sent.Url.Host == "alarms.example"), "the alarm to be sent");

        // A moment for a third of the flows' posts to have gone out, if one were going to.
        await Task.Delay(50);
        Assert.Equal(WebhookDispatcher.FlowsInFlight, Handler.Sent.Count(sent => sent.Url.Host != "alarms.example"));
    }

    // After StopAsync the queue is closed, which is not a queue that overflowed: nothing was dropped, and
    // the post that did not go in must not be left counted as waiting for a pump that has stopped. Seventeen to
    // one endpoint, one more than may wait there: each refused post gives its place back, so the last is refused
    // for the closed queue as the first was, and not dropped for a cap that places nobody gave back had filled.
    [Fact]
    public async Task Flows_posts_after_the_queue_has_closed_are_refused_and_each_gives_its_place_back()
    {
        var sut = await Started((_, _) => Status(HttpStatusCode.OK));

        using var patience = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await sut.StopAsync(patience.Token);

        for (var i = 0; i <= WebhookDispatcher.FlowPostsPerEndpoint; i++)
            Assert.False(sut.Post(Posting(), _ => { }));

        Assert.Equal(0, sut.Pending);
        Assert.Equal(0, sut.Dropped);
        Assert.Empty(FlowPostsAt(sut));
    }

    // The second lock on the door the wiring already shut: the engine is handed no webhook channel when
    // the switch is off, so this is the branch nothing reaches today, and the one that has to hold the day
    // something does. The refusal is said through the callback and the answer is still true, because it
    // was handled: a false would have the engine count a full queue on the node on top of it.
    [Fact]
    public async Task A_flows_post_with_webhooks_turned_off_is_said_back_and_sends_nothing()
    {
        var sut = await Started((_, _) => Status(HttpStatusCode.OK), allowWebhooks: false);
        var said = new ConcurrentQueue<string>();

        Assert.True(sut.Post(Posting(), said.Enqueue));

        // The engine's sentence, word for word: a node says the same thing whichever of the two locks held.
        Assert.Equal(IFlowWebhook.TurnedOff, Assert.Single(said));
        Assert.Contains("AllowWebhooks", IFlowWebhook.TurnedOff);

        await Task.Delay(50);
        Assert.Empty(Handler.Sent);
        Assert.Equal(0, sut.Pending);
    }

    // The same rule an alert's is held to, on the path a flow's post takes too: a redirect is an endpoint
    // that did not accept the post, and where it points is never read.
    [Fact]
    public async Task A_flows_post_is_not_chased_through_a_redirect()
    {
        var sut = await Started((_, _) =>
        {
            var response = new HttpResponseMessage(HttpStatusCode.Found);
            response.Headers.Location = new Uri("http://elsewhere.example/collect");

            return Task.FromResult(response);
        });
        var said = new ConcurrentQueue<string>();

        sut.Post(Posting(), said.Enqueue);
        await AdvanceUntil(() => !said.IsEmpty, "the post was given up on");

        Assert.Equal(3, Handler.Sent.Count);
        Assert.All(Handler.Sent, sent => Assert.Equal(EndpointA, sent.Url.ToString()));
        Assert.Contains("302", Assert.Single(said));
    }

    // The dispatcher shows nobody how many of the flows' posts are waiting at each endpoint, since nothing outside
    // it has a use for the number. By name, so a rename is said as one here and not as a NullReferenceException
    // that sends the reader looking at the dispatcher.
    private static IReadOnlyDictionary<string, int> FlowPostsAt(WebhookDispatcher sut)
    {
        var field = typeof(WebhookDispatcher).GetField("_flowPostsAt", BindingFlags.Instance | BindingFlags.NonPublic)
                    ?? throw new InvalidOperationException(
                        "WebhookDispatcher has no field called _flowPostsAt any more, which counts the flows' posts " +
                        "waiting at each endpoint. Point this test at wherever the dispatcher keeps that count now.");

        return (IReadOnlyDictionary<string, int>)field.GetValue(sut)!;
    }

    // The content type is the media type alone: the charset the content adds after it is the encoding's
    // business and not what a delivery was asked to say.
    private sealed record Sent(
        HttpMethod Method, Uri Url, IReadOnlyDictionary<string, string> Headers, string Body, string? ContentType);

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
            lock (_gate) _sent.Add(new Sent(request.Method, request.RequestUri!, headers, body,
                request.Content?.Headers.ContentType?.MediaType));

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
