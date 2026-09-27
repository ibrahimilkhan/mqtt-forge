using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using MqttForge.Api.Hubs;
using MqttForge.Api.Realtime;
using MqttForge.IntegrationTests.Support;
using NSubstitute;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

// No broker: everything here is reachable without one, including a flow alarm — an Inject node
// wired to an Alarm raises it, which is the one route to GET /api/alerts that needs no traffic.
public sealed class FlowEndpointTests : IClassFixture<MqttForgeApiFactory>
{
    private readonly MqttForgeApiFactory _factory;
    private readonly HttpClient _client;

    public FlowEndpointTests(MqttForgeApiFactory factory)
    {
        _factory = factory;
        _client = factory.CreateClient();
    }

    private static object Flow(string id, string alarmName = "Pressed", string injectId = "go") => new
    {
        id,
        name = "Button",
        enabled = true,
        nodes = new object[]
        {
            new { id = injectId, type = "inject", x = 40, y = 80, config = new { topic = "plant/k1/button", payload = "1" } },
            new { id = "ring", type = "alarm", x = 260, y = 80, config = new { name = alarmName, severity = "warn", reason = "{{topic}} pressed" } },
        },
        edges = new object[] { new { id = "e1", from = injectId, fromPort = "out", to = "ring", toPort = "raise" } },
    };

    private static async Task<JsonElement> Json(HttpResponseMessage response) =>
        JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone();

    private static async Task Until(Func<Task<bool>> settled, string what)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(10);
        while (DateTime.UtcNow < deadline)
        {
            if (await settled()) return;
            await Task.Delay(50);
        }

        Assert.Fail($"Timed out waiting until {what}.");
    }

    [Fact]
    public async Task A_fresh_host_lists_no_flows_and_the_two_facts_an_editor_needs()
    {
        using var fresh = new MqttForgeApiFactory();
        var body = await Json(await fresh.CreateClient().GetAsync("/api/flows"));

        Assert.Equal(0, body.GetProperty("flows").GetArrayLength());
        Assert.False(body.GetProperty("unreadable").GetBoolean());
        Assert.False(body.GetProperty("allowWebhooks").GetBoolean());
        Assert.Equal("mqttforge/alerts/", body.GetProperty("alertTopicPrefix").GetString());
    }

    [Fact]
    public async Task A_deployed_flow_is_kept_listed_and_written_down()
    {
        var response = await _client.PutAsJsonAsync("/api/flows/listed", Flow("listed"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("listed", (await Json(response)).GetProperty("flow").GetProperty("id").GetString());

        var list = await Json(await _client.GetAsync("/api/flows"));
        Assert.Contains(list.GetProperty("flows").EnumerateArray(), flow => flow.GetProperty("id").GetString() == "listed");
        Assert.Contains("\"listed\"", await File.ReadAllTextAsync(_factory.FlowsPath));
    }

    [Fact]
    public async Task A_flow_that_does_not_compile_is_a_400_naming_the_node()
    {
        var response = await _client.PutAsJsonAsync("/api/flows/broken", new
        {
            id = "broken", name = "Broken", enabled = true,
            nodes = new[] { new { id = "n1", type = "teleport", x = 0, y = 0, config = new { } } },
            edges = Array.Empty<object>(),
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await Json(response);
        Assert.Equal("flowInvalid", problem.GetProperty("reason").GetString());
        Assert.True(problem.GetProperty("errors").TryGetProperty("node:n1", out _));
    }

    // A hand-built body — the console never sends a hole in either array, but a PUT typed by hand
    // or replayed from a bad client can. FlowCompiler already answers a null element with a
    // flow-level problem ("A node in this flow is empty." / "A wire in this flow is empty."); this
    // is only proof that FlowDto.ToFlow() hands it the null rather than dereferencing it first.
    [Theory]
    [InlineData("""{"id":"hole","name":"Hole","enabled":true,"nodes":[null],"edges":[]}""")]
    [InlineData("""{"id":"hole","name":"Hole","enabled":true,"nodes":[],"edges":[null]}""")]
    public async Task A_null_node_or_edge_in_the_body_is_a_400_rather_than_a_500(string body)
    {
        var response = await _client.PutAsync("/api/flows/hole",
            new StringContent(body, Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await Json(response);
        Assert.Equal("flowInvalid", problem.GetProperty("reason").GetString());
        Assert.True(problem.GetProperty("errors").TryGetProperty("flow", out _));
    }

    [Fact]
    public async Task An_id_in_the_address_that_differs_from_the_body_is_refused() =>
        Assert.Equal(HttpStatusCode.BadRequest,
            (await _client.PutAsJsonAsync("/api/flows/other", Flow("mismatch"))).StatusCode);

    [Fact]
    public async Task Deleting_a_flow_is_204_and_deleting_nothing_is_404()
    {
        await _client.PutAsJsonAsync("/api/flows/doomed", Flow("doomed"));

        Assert.Equal(HttpStatusCode.NoContent, (await _client.DeleteAsync("/api/flows/doomed")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _client.DeleteAsync("/api/flows/doomed")).StatusCode);
    }

    // A deploy is answered once the engine is running the flow, so its button works the moment the
    // answer comes back — with no waiting and no second try.
    [Fact]
    public async Task A_flow_can_be_injected_the_moment_its_deploy_is_answered()
    {
        Assert.Equal(HttpStatusCode.OK, (await _client.PutAsJsonAsync("/api/flows/ready", Flow("ready"))).StatusCode);

        Assert.Equal(HttpStatusCode.Accepted, (await _client.PostAsync("/api/flows/ready/nodes/go/inject", null)).StatusCode);
    }

    [Fact]
    public async Task Injecting_a_node_no_running_flow_has_is_404() =>
        Assert.Equal(HttpStatusCode.NotFound,
            (await _client.PostAsync("/api/flows/nobody/nodes/nothing/inject", null)).StatusCode);

    [Fact]
    public async Task An_injected_alarm_is_in_the_flow_status_and_in_GET_alerts()
    {
        await _client.PutAsJsonAsync("/api/flows/button", Flow("button", alarmName: "Button pressed"));

        await Until(async () =>
            (await _client.PostAsync("/api/flows/button/nodes/go/inject", null)).StatusCode == HttpStatusCode.Accepted,
            "the deployed flow to accept an inject");

        await Until(async () =>
        {
            var alerts = await Json(await _client.GetAsync("/api/alerts"));
            return alerts.GetProperty("active").EnumerateArray().Any(alert =>
                alert.GetProperty("ruleId").GetString() == "flow-button-ring" &&
                alert.GetProperty("ruleName").GetString() == "Button · Button pressed" &&
                alert.GetProperty("reason").GetString() == "plant/k1/button pressed");
        }, "the flow alarm to be in GET /api/alerts");

        await Until(async () =>
        {
            var status = await Json(await _client.GetAsync("/api/flows/status"));
            return status.GetProperty("flows").EnumerateArray().Any(flow =>
                flow.GetProperty("id").GetString() == "button" &&
                flow.GetProperty("nodes").EnumerateArray().Any(node =>
                    node.GetProperty("id").GetString() == "ring" && node.GetProperty("standing").GetArrayLength() == 1));
        }, "the status to show the standing alarm");
    }

    // The other half of the merge AlertController.WithFlows does: GET /api/alerts replaces its
    // whole active/history state on every read, so a flow alarm that cleared has to leave active
    // and land in history in the very same answer, the way an alert-rule alarm does.
    [Fact]
    public async Task A_cleared_flow_alarm_leaves_active_and_lands_in_history_as_cleared()
    {
        var flow = new
        {
            id = "toggle",
            name = "Toggle",
            enabled = true,
            nodes = new object[]
            {
                new { id = "raiseGo", type = "inject", x = 40, y = 40, config = new { topic = "plant/k1/button", payload = "1" } },
                new { id = "clearGo", type = "inject", x = 40, y = 160, config = new { topic = "plant/k1/button", payload = "0" } },
                new { id = "ring", type = "alarm", x = 260, y = 100, config = new { name = "Pressed", severity = "warn", reason = "{{topic}} pressed" } },
            },
            edges = new object[]
            {
                new { id = "e1", from = "raiseGo", fromPort = "out", to = "ring", toPort = "raise" },
                new { id = "e2", from = "clearGo", fromPort = "out", to = "ring", toPort = "clear" },
            },
        };

        await _client.PutAsJsonAsync("/api/flows/toggle", flow);

        await Until(async () =>
            (await _client.PostAsync("/api/flows/toggle/nodes/raiseGo/inject", null)).StatusCode == HttpStatusCode.Accepted,
            "the deployed flow to accept the raise inject");

        await Until(async () =>
        {
            var alerts = await Json(await _client.GetAsync("/api/alerts"));
            return alerts.GetProperty("active").EnumerateArray()
                .Any(alert => alert.GetProperty("ruleId").GetString() == "flow-toggle-ring");
        }, "the raised alarm to reach GET /api/alerts");

        await Until(async () =>
            (await _client.PostAsync("/api/flows/toggle/nodes/clearGo/inject", null)).StatusCode == HttpStatusCode.Accepted,
            "the deployed flow to accept the clear inject");

        await Until(async () =>
        {
            var alerts = await Json(await _client.GetAsync("/api/alerts"));

            var stillActive = alerts.GetProperty("active").EnumerateArray()
                .Any(alert => alert.GetProperty("ruleId").GetString() == "flow-toggle-ring");
            var clearedInHistory = alerts.GetProperty("history").EnumerateArray()
                .Any(alert => alert.GetProperty("ruleId").GetString() == "flow-toggle-ring" &&
                              alert.GetProperty("resolvedBy").GetString() == "clear");

            return !stillActive && clearedInHistory;
        }, "the cleared alarm to leave active and land in history");
    }

    // The Alerts panel's "clear history" is one button for one list, and GET /api/alerts merges the
    // flows' history into it: a flow alarm left behind would come back on the next read.
    [Fact]
    public async Task Clearing_the_alert_history_clears_the_flows_history_too_and_leaves_what_stands()
    {
        using var fresh = new MqttForgeApiFactory();
        var client = fresh.CreateClient();

        await client.PutAsJsonAsync("/api/flows/pair", new
        {
            id = "pair",
            name = "Pair",
            enabled = true,
            nodes = new object[]
            {
                new { id = "raiseGo", type = "inject", x = 40, y = 40, config = new { topic = "plant/k1/button", payload = "1" } },
                new { id = "clearGo", type = "inject", x = 40, y = 160, config = new { topic = "plant/k1/button", payload = "0" } },
                new { id = "otherGo", type = "inject", x = 40, y = 280, config = new { topic = "plant/k2/button", payload = "1" } },
                new { id = "ring", type = "alarm", x = 260, y = 100, config = new { name = "Pressed", severity = "warn" } },
            },
            edges = new object[]
            {
                new { id = "e1", from = "raiseGo", fromPort = "out", to = "ring", toPort = "raise" },
                new { id = "e2", from = "clearGo", fromPort = "out", to = "ring", toPort = "clear" },
                new { id = "e3", from = "otherGo", fromPort = "out", to = "ring", toPort = "raise" },
            },
        });

        foreach (var node in new[] { "raiseGo", "clearGo", "otherGo" })
            await Until(async () =>
                (await client.PostAsync($"/api/flows/pair/nodes/{node}/inject", null)).StatusCode == HttpStatusCode.Accepted,
                $"the flow to accept {node}");

        static bool Ours(JsonElement alert) => alert.GetProperty("ruleId").GetString() == "flow-pair-ring";

        await Until(async () =>
        {
            var alerts = await Json(await client.GetAsync("/api/alerts"));
            return alerts.GetProperty("history").EnumerateArray().Any(Ours) &&
                   alerts.GetProperty("active").EnumerateArray().Any(Ours);
        }, "one flow alarm to have ended and one to stand");

        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync("/api/alerts/history")).StatusCode);

        await Until(async () =>
            !(await Json(await client.GetAsync("/api/alerts"))).GetProperty("history").EnumerateArray().Any(Ours),
            "the flow alarm that ended to leave the history");

        var standing = (await Json(await client.GetAsync("/api/alerts"))).GetProperty("active").EnumerateArray().Where(Ours).ToList();
        Assert.Equal("plant/k2/button", Assert.Single(standing).GetProperty("topic").GetString());
    }

    // The consoles stop reading as the first alarm is sent to them, so its frame sits until it is
    // called off. The flows do not wait with it: the second button's alarm is raised with the first
    // one's frame still stuck, and stopping the host is what lets that frame go.
    [Fact]
    public async Task A_console_that_stops_reading_holds_up_no_flow_alarm_and_is_let_go_when_the_host_stops()
    {
        var hub = new StalledHub(holding: SignalRAlertNotifier.AlertsRaised);
        using var factory = new MqttForgeApiFactory();
        var host = factory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
        {
            services.AddSingleton(new SignalRAlertNotifier(hub.Context));
            services.AddSingleton(sp => new SignalRFlowNotifier(hub.Context, sp.GetRequiredService<SignalRAlertNotifier>()));
        }));
        var client = host.CreateClient();

        await client.PutAsJsonAsync("/api/flows/bells", new
        {
            id = "bells",
            name = "Bells",
            enabled = true,
            nodes = new object[]
            {
                new { id = "one", type = "inject", x = 40, y = 40, config = new { topic = "plant/k1/button", payload = "1" } },
                new { id = "two", type = "inject", x = 40, y = 160, config = new { topic = "plant/k2/button", payload = "1" } },
                new { id = "ring", type = "alarm", x = 260, y = 100, config = new { name = "Pressed", severity = "warn" } },
            },
            edges = new object[]
            {
                new { id = "e1", from = "one", fromPort = "out", to = "ring", toPort = "raise" },
                new { id = "e2", from = "two", fromPort = "out", to = "ring", toPort = "raise" },
            },
        });

        async Task<int> Standing() =>
            (await Json(await client.GetAsync("/api/alerts"))).GetProperty("active").EnumerateArray()
                .Count(alert => alert.GetProperty("ruleId").GetString() == "flow-bells-ring");

        Assert.Equal(HttpStatusCode.Accepted, (await client.PostAsync("/api/flows/bells/nodes/one/inject", null)).StatusCode);
        await Until(() => Task.FromResult(hub.Held == 1), "the first alarm's frame to be stuck with the console");

        Assert.Equal(HttpStatusCode.Accepted, (await client.PostAsync("/api/flows/bells/nodes/two/inject", null)).StatusCode);
        await Until(async () => await Standing() == 2, "the second alarm to be raised, with the first one's frame still stuck");

        await host.DisposeAsync();

        Assert.Equal(0, hub.Held);
    }

    /// <summary>
    /// A hub whose sends of one method wait until their token calls them off — consoles that stopped
    /// reading when that was sent — and whose other sends go through.
    /// </summary>
    private sealed class StalledHub
    {
        private int _held;

        public StalledHub(string holding)
        {
            var proxy = Substitute.For<IClientProxy>();
            proxy
                .SendCoreAsync(Arg.Any<string>(), Arg.Any<object?[]>(), Arg.Any<CancellationToken>())
                .Returns(call => call.ArgAt<string>(0) == holding ? HoldAsync(call.ArgAt<CancellationToken>(2)) : Task.CompletedTask);

            var clients = Substitute.For<IHubClients>();
            clients.All.Returns(proxy);

            Context = Substitute.For<IHubContext<MqttHub>>();
            Context.Clients.Returns(clients);
        }

        public IHubContext<MqttHub> Context { get; }

        /// <summary>How many sends are waiting on the consoles right now.</summary>
        public int Held => Volatile.Read(ref _held);

        private async Task HoldAsync(CancellationToken ct)
        {
            Interlocked.Increment(ref _held);
            try
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, ct);
            }
            finally
            {
                Interlocked.Decrement(ref _held);
            }
        }
    }

    [Fact]
    public async Task A_file_this_build_cannot_read_is_a_409_and_is_left_alone()
    {
        using var damaged = new MqttForgeApiFactory();
        await File.WriteAllTextAsync(damaged.FlowsPath, "not json");

        var response = await damaged.CreateClient().PutAsJsonAsync("/api/flows/x", Flow("x"));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("flowsUnreadable", (await Json(response)).GetProperty("reason").GetString());
        Assert.Equal("not json", await File.ReadAllTextAsync(damaged.FlowsPath));
    }
}
