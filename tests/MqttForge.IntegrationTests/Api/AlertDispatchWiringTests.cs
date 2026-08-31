using System.Threading.Channels;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using MqttForge.Api;
using MqttForge.Api.Realtime;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Alerts;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

/// <summary>
/// Which channels a build actually holds, in what order they come up, and what the webhook one
/// was handed to talk with.
/// </summary>
// Its own file rather than more of AlertWiringTests, which is already long and is about the
// engine's own registrations. This one is about what leaves the process, which is the half an
// operator can be surprised by.
public class AlertDispatchWiringTests
{
    private static readonly DateTimeOffset T0 = new(2026, 8, 30, 9, 0, 0, TimeSpan.Zero);

    private static WebApplication Host(params string[] extra) =>
        MqttForgeHost.Build([
            $"--MqttForge:SettingsPath={Temp("dispatch-settings")}",
            $"--MqttForge:AlertRulesPath={Temp("dispatch-rules")}",
            $"--MqttForge:AlertStatePath={Temp("dispatch-state")}",
            .. extra
        ]);

    private static string Temp(string what) =>
        Path.Combine(Path.GetTempPath(), $"mqttforge-{what}-{Guid.NewGuid():N}.json");

    private static Alert Ringing(string url) =>
        new("a1", "hot", "Boiler temperature", "plant/boiler/temp", AlertSeverity.Critical,
            FiredAt: T0, LastSeenAt: T0, ResolvedAt: null, ResolvedBy: null, MutedUntil: null,
            Count: 1, Reason: "94.2 > 90", Value: 94.2, Sample: "94.2",
            Actions: [new WebhookAction(url, new Dictionary<string, string>())]);

    // The console's events and the container's log are both channels, and both have to be there.
    // A build that resolved one of them alone would look completely healthy from the other end.
    [Fact]
    public async Task The_notifier_the_engine_holds_tells_the_log_and_the_console()
    {
        await using var app = Host();

        Assert.IsType<CompositeAlertNotifier>(app.Services.GetRequiredService<IAlertNotifier>());

        // Registered under their own types as well, because the composite is not the only caller:
        // the mute endpoint resolves SignalRAlertNotifier by name to announce a mute.
        Assert.NotNull(app.Services.GetRequiredService<SignalRAlertNotifier>());
        Assert.NotNull(app.Services.GetRequiredService<LoggingAlertNotifier>());
    }

    [Fact]
    public async Task Both_outgoing_channels_are_in_the_dispatcher_when_webhooks_are_on()
    {
        await using var app = Host();

        var composite = Assert.IsType<CompositeAlertDispatcher>(
            app.Services.GetRequiredService<IAlertDispatcher>());

        Assert.Single(composite.Targets.OfType<WebhookDispatcher>());
        Assert.Single(composite.Targets.OfType<MqttAlertDispatcher>());
    }

    // The outer of the two gates, and the blunt one: a rules file with a webhook in it must not be
    // able to make a build with the switch off POST anywhere, whatever the dispatcher believes.
    [Fact]
    public async Task A_build_with_webhooks_off_does_not_hold_the_webhook_channel()
    {
        await using var app = Host("--MqttForge:AllowWebhooks=false");

        var composite = Assert.IsType<CompositeAlertDispatcher>(
            app.Services.GetRequiredService<IAlertDispatcher>());

        Assert.Empty(composite.Targets.OfType<WebhookDispatcher>());

        // The broker channel is untouched: turning webhooks off is about what leaves for an
        // address the operator typed, not about alerting stopping.
        Assert.Single(composite.Targets.OfType<MqttAlertDispatcher>());
    }

    // Hosted services start in registration order. The webhook pump has to be draining before the
    // engine that feeds it starts, or the first alarm of a run is handed to a queue with nothing
    // behind it — which is the same bug the engine and the supervisor are already ordered against.
    [Fact]
    public async Task The_webhook_pump_comes_up_before_the_engine_that_feeds_it()
    {
        await using var app = Host();

        var hosted = app.Services.GetServices<IHostedService>().ToList();

        Assert.Same(
            app.Services.GetRequiredService<WebhookDispatcher>(),
            hosted.OfType<WebhookDispatcher>().Single());

        Assert.True(
            hosted.FindIndex(service => service is WebhookDispatcher)
            < hosted.FindIndex(service => service is AlertEngineHost),
            "the webhook queue must be draining before the engine starts filling it");
    }

    /// <summary>
    /// The client the container actually put in the dispatcher, proved by what it does with a 302.
    /// </summary>
    // This test exists because the wrong registration works. AddHttpClient(name, …) also registers
    // a bare transient HttpClient bound to the UNNAMED client, so services.AddSingleton<
    // WebhookDispatcher>() resolves cleanly and hands it the default handler — which follows
    // redirects, silently, in production only. WebhookDispatcherTests can never see that: it
    // builds its own client. So the assertion has to be made here, on a client that came out of
    // this container, and it has to be made on behaviour rather than on a static member.
    //
    // Two POSTs to the first address is the proof, and it is an event rather than a sleep: a 3xx
    // is a failure to this dispatcher, so it comes back to the same URL after its first backoff.
    // A client that followed the redirect would instead have got a 200 from the second address,
    // called the delivery done, and never posted again.
    [Fact]
    public async Task The_client_the_container_hands_the_dispatcher_does_not_follow_redirects()
    {
        await using var probe = await RedirectProbe.StartAsync();
        await using var app = Host();

        var dispatcher = app.Services.GetRequiredService<WebhookDispatcher>();

        // Started by hand. Nothing else in this host is running — no broker, no engine, no
        // supervisor — because the only thing under test is the client this one object holds.
        await dispatcher.StartAsync(CancellationToken.None);

        try
        {
            await dispatcher.RaisedAsync([Ringing(probe.HookUrl)]);

            await probe.NextPostAsync();
            await probe.NextPostAsync();

            Assert.Equal(0, probe.Followed);
        }
        finally
        {
            // Cancels the ladder rather than waiting it out: StopAsync stops the retries first and
            // drains second, which is what makes this finally block quick.
            await dispatcher.StopAsync(CancellationToken.None);
        }
    }

    /// <summary>An endpoint that answers every POST with a 302 to a second address of its own.</summary>
    // A real socket on a loopback port, for the same reason task 8's probe is one: a substitute
    // handler would prove what this class asked for, and the question here is what the handler the
    // container built does with the answer.
    private sealed class RedirectProbe : IAsyncDisposable
    {
        private readonly Channel<int> _posts = Channel.CreateUnbounded<int>();
        private readonly WebApplication _app;

        private int _followed;

        private RedirectProbe(WebApplication app) => _app = app;

        public static async Task<RedirectProbe> StartAsync()
        {
            var builder = WebApplication.CreateBuilder();

            // Port zero, so parallel runs never collide on a number, and loopback only, so nothing
            // outside this machine can reach it even for the seconds it is up.
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            builder.Logging.ClearProviders();

            var app = builder.Build();
            var probe = new RedirectProbe(app);

            app.MapPost("/hook", () =>
            {
                probe._posts.Writer.TryWrite(1);

                return Results.Redirect($"{probe.Origin}/followed");
            });

            // Both verbs: .NET turns a POST into a GET when it follows a 302, so a handler that
            // only took POSTs would miss exactly the failure this probe is watching for.
            app.MapMethods("/followed", ["GET", "POST"], () =>
            {
                Interlocked.Increment(ref probe._followed);

                return Results.Ok();
            });

            await app.StartAsync();

            return probe;
        }

        /// <summary>The address the port was actually assigned. Only known after StartAsync.</summary>
        public string Origin => _app.Urls.First();

        public string HookUrl => $"{Origin}/hook";

        /// <summary>How many times anything reached the address the 302 pointed at.</summary>
        public int Followed => Volatile.Read(ref _followed);

        public async Task<int> NextPostAsync()
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));

            return await _posts.Reader.ReadAsync(timeout.Token);
        }

        public async ValueTask DisposeAsync() => await _app.DisposeAsync();
    }
}
