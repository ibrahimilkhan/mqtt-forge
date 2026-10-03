using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using MqttForge.Api.Realtime;
using MqttForge.Application.Flows;
using MqttForge.IntegrationTests.Support;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

// No broker: everything here is reachable without one, including a flow alarm — a Raise alarm right
// after Start goes up the moment its flow is switched on, which is the one route to GET /api/alerts
// that needs no traffic.
public sealed class FlowEndpointTests : IClassFixture<MqttForgeApiFactory>
{
    private readonly MqttForgeApiFactory _factory;
    private readonly HttpClient _client;

    public FlowEndpointTests(MqttForgeApiFactory factory)
    {
        _factory = factory;
        _client = factory.CreateClient();
    }

    private static object Node(string id, string type, object? config = null) =>
        new { id, type, x = 0, y = 0, config = config ?? new { } };

    private static object Wire(string id, string from, string fromPort, string to) =>
        new { id, from, fromPort, to, toPort = "in" };

    /// <summary>Start → Raise alarm ring → End: the alarm goes up the moment the flow is switched on.</summary>
    private static object Flow(string id, string alarmName = "Pressed") => new
    {
        id,
        name = "Button",
        enabled = true,
        nodes = new[]
        {
            Node("start", "start"),
            Node("ring", "alarmRaise", new { name = alarmName, level = "warn", reason = "pressed" }),
            Node("end", "end"),
        },
        edges = new[]
        {
            Wire("e1", "start", "out", "ring"),
            Wire("e2", "ring", "raised", "end"),
            Wire("e3", "ring", "up", "end"),
        },
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

        // Activate, Update and Deactivate all save, and what a refusal says happened is that nothing was.
        Assert.Equal("The flow was not saved", problem.GetProperty("title").GetString());
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

    // A save is answered once the engine is running the flow, so it is switched on the moment the answer
    // comes back, with no waiting and no second try. The status is what the engine last pushed, a quarter
    // second at most behind, and shows the run in the words the console reads.
    [Fact]
    public async Task An_activated_flow_is_switched_on_once_its_save_is_answered_and_shows_in_the_status()
    {
        Assert.Equal(HttpStatusCode.OK, (await _client.PutAsJsonAsync("/api/flows/ready", Flow("ready"))).StatusCode);

        Assert.True(_factory.Services.GetRequiredService<FlowEngine>().IsActive("ready"));

        var runs = new List<JsonElement>();
        await Until(async () =>
        {
            var status = await Json(await _client.GetAsync("/api/flows/status"));
            runs = [.. status.GetProperty("runs").EnumerateArray().Where(run => run.GetProperty("flowId").GetString() == "ready")];
            return runs.Count > 0;
        }, "the status to show the flow's run");

        var ready = Assert.Single(runs);
        Assert.Equal("active", ready.GetProperty("kind").GetString());
        Assert.Equal("finished", ready.GetProperty("state").GetString());
        Assert.Equal("end", ready.GetProperty("at").GetString());
        Assert.Equal(JsonValueKind.Null, ready.GetProperty("waiting").ValueKind);
        Assert.Equal(JsonValueKind.Object, ready.GetProperty("variables").ValueKind);
    }

    [Fact]
    public async Task An_activated_flows_alarm_is_in_the_flow_status_and_in_GET_alerts()
    {
        Assert.Equal(HttpStatusCode.OK,
            (await _client.PutAsJsonAsync("/api/flows/button", Flow("button", alarmName: "Button pressed"))).StatusCode);

        await Until(async () =>
        {
            var alerts = await Json(await _client.GetAsync("/api/alerts"));
            return alerts.GetProperty("active").EnumerateArray().Any(alert =>
                alert.GetProperty("ruleId").GetString() == "flow-button-ring" &&
                alert.GetProperty("ruleName").GetString() == "Button · Button pressed" &&
                alert.GetProperty("reason").GetString() == "pressed");
        }, "the flow alarm to be in GET /api/alerts");

        await Until(async () =>
        {
            var status = await Json(await _client.GetAsync("/api/flows/status"));
            return status.GetProperty("runs").EnumerateArray().Any(run =>
                run.GetProperty("flowId").GetString() == "button" &&
                run.GetProperty("nodes").EnumerateArray().Any(node =>
                    node.GetProperty("id").GetString() == "ring" && node.GetProperty("standing").GetArrayLength() == 1));
        }, "the status to show the standing alarm");
    }

    // The other half of the merge AlertController.WithFlows does: GET /api/alerts replaces its
    // whole active/history state on every read, so a flow alarm that cleared has to leave active
    // and land in history in the very same answer, the way an alert-rule alarm does.
    //
    // The flow raises and clears on its own, half a second apart, so what is read is the end of it:
    // a window of half a second to see the alarm up as well would fail on a machine busy enough.
    [Fact]
    public async Task A_cleared_flow_alarm_leaves_active_and_lands_in_history_as_cleared()
    {
        var flow = new
        {
            id = "toggle",
            name = "Toggle",
            enabled = true,
            nodes = new[]
            {
                Node("start", "start"),
                Node("ring", "alarmRaise", new { name = "Pressed", level = "warn", reason = "pressed" }),
                Node("pause", "wait", new { seconds = "0.5" }),
                Node("clear", "alarmClear", new { alarm = "ring" }),
                Node("end", "end"),
            },
            edges = new[]
            {
                Wire("e1", "start", "out", "ring"),
                Wire("e2", "ring", "raised", "pause"),
                Wire("e3", "ring", "up", "pause"),
                Wire("e4", "pause", "out", "clear"),
                Wire("e5", "clear", "cleared", "end"),
                Wire("e6", "clear", "none", "end"),
            },
        };

        Assert.Equal(HttpStatusCode.OK, (await _client.PutAsJsonAsync("/api/flows/toggle", flow)).StatusCode);

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

        // One alarm raised and cleared, and another raised and left standing.
        await client.PutAsJsonAsync("/api/flows/pair", new
        {
            id = "pair",
            name = "Pair",
            enabled = true,
            nodes = new[]
            {
                Node("start", "start"),
                Node("ring", "alarmRaise", new { name = "Pressed", level = "warn" }),
                Node("clear", "alarmClear", new { alarm = "ring" }),
                Node("other", "alarmRaise", new { name = "Other", level = "warn" }),
                Node("end", "end"),
            },
            edges = new[]
            {
                Wire("e1", "start", "out", "ring"),
                Wire("e2", "ring", "raised", "clear"),
                Wire("e3", "ring", "up", "clear"),
                Wire("e4", "clear", "cleared", "other"),
                Wire("e5", "clear", "none", "other"),
                Wire("e6", "other", "raised", "end"),
                Wire("e7", "other", "up", "end"),
            },
        });

        static bool Ours(JsonElement alert) => alert.GetProperty("ruleId").GetString()!.StartsWith("flow-pair-", StringComparison.Ordinal);

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
        Assert.Equal("flow-pair-other", Assert.Single(standing).GetProperty("ruleId").GetString());
    }

    // The consoles stop reading as the first alarm is sent to them, so its frame sits until it is
    // called off. The flows do not wait with it: the second alarm is raised half a second later with
    // the first one's frame still stuck, and stopping the host is what lets that frame go.
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

        var saved = await client.PutAsJsonAsync("/api/flows/bells", new
        {
            id = "bells",
            name = "Bells",
            enabled = true,
            nodes = new[]
            {
                Node("start", "start"),
                Node("one", "alarmRaise", new { name = "First", level = "warn" }),
                Node("pause", "wait", new { seconds = "0.5" }),
                Node("two", "alarmRaise", new { name = "Second", level = "warn" }),
                Node("end", "end"),
            },
            edges = new[]
            {
                Wire("e1", "start", "out", "one"),
                Wire("e2", "one", "raised", "pause"),
                Wire("e3", "one", "up", "pause"),
                Wire("e4", "pause", "out", "two"),
                Wire("e5", "two", "raised", "end"),
                Wire("e6", "two", "up", "end"),
            },
        });
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);

        async Task<int> Standing() =>
            (await Json(await client.GetAsync("/api/alerts"))).GetProperty("active").EnumerateArray()
                .Count(alert => alert.GetProperty("ruleId").GetString()!.StartsWith("flow-bells-", StringComparison.Ordinal));

        await Until(() => Task.FromResult(hub.Held == 1), "the first alarm's frame to be stuck with the console");
        await Until(async () => await Standing() == 2, "the second alarm to be raised, with the first one's frame still stuck");

        await host.DisposeAsync();

        Assert.Equal(0, hub.Held);
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

    // ---- a test of the drawing ----

    /// <summary>Start → MQTT in on plant/+/temp → End: a run that waits for its message, with no broker to send one.</summary>
    private static object Waiting(string id) => new
    {
        id,
        name = "Waits",
        enabled = true,
        nodes = new object[]
        {
            new { id = "start", type = "start", x = 0, y = 0, config = new { } },
            new { id = "in", type = "mqttIn", x = 200, y = 0, config = new { filter = "plant/+/temp" } },
            new { id = "end", type = "end", x = 400, y = 0, config = new { } },
        },
        edges = new object[]
        {
            new { id = "e1", from = "start", fromPort = "out", to = "in", toPort = "in" },
            new { id = "e2", from = "in", fromPort = "out", to = "end", toPort = "in" },
        },
    };

    [Fact]
    public async Task A_test_is_202_and_runs_beside_nothing_saved()
    {
        Assert.Equal(HttpStatusCode.Accepted, (await _client.PostAsJsonAsync("/api/flows/probe/test", Waiting("probe"))).StatusCode);

        await Until(async () =>
        {
            var status = await Json(await _client.GetAsync("/api/flows/status"));
            return status.GetProperty("runs").EnumerateArray().Any(run =>
                run.GetProperty("flowId").GetString() == "probe" &&
                run.GetProperty("kind").GetString() == "test" &&
                run.GetProperty("state").GetString() == "waiting");
        }, "the test run to wait for its message");

        var flows = await Json(await _client.GetAsync("/api/flows"));
        Assert.DoesNotContain(flows.GetProperty("flows").EnumerateArray(), flow => flow.GetProperty("id").GetString() == "probe");

        Assert.Equal(HttpStatusCode.NoContent, (await _client.DeleteAsync("/api/flows/probe/test")).StatusCode);
    }

    // Refused in a save's shape and with a save's reason, so the console marks the nodes of a refused test
    // as it marks a refused save's; the title alone says which it was.
    [Fact]
    public async Task A_test_that_does_not_compile_is_a_400_naming_the_node()
    {
        var response = await _client.PostAsJsonAsync("/api/flows/broken/test", new
        {
            id = "broken", name = "Broken", enabled = true,
            nodes = new object[] { new { id = "start", type = "start", x = 0, y = 0, config = new { } } },
            edges = Array.Empty<object>(),
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await Json(response);
        Assert.Equal("flowInvalid", problem.GetProperty("reason").GetString());
        Assert.Equal("The flow was not tested", problem.GetProperty("title").GetString());
        Assert.True(problem.GetProperty("errors").TryGetProperty("node:start", out _));
    }

    [Fact]
    public async Task Stopping_a_test_that_is_not_going_is_404()
    {
        var response = await _client.DeleteAsync("/api/flows/nobody/test");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("testUnknown", (await Json(response)).GetProperty("reason").GetString());
    }

    /// <summary>Whether GET /api/flows/status shows a test run of the flow, in <paramref name="state"/> when one is given.</summary>
    private static async Task<bool> TestShown(HttpClient client, string id, string? state = null)
    {
        var status = await Json(await client.GetAsync("/api/flows/status"));

        return status.GetProperty("runs").EnumerateArray().Any(run =>
            run.GetProperty("flowId").GetString() == id &&
            run.GetProperty("kind").GetString() == "test" &&
            (state is null || run.GetProperty("state").GetString() == state));
    }

    // The console deletes a draft that was never saved here as well. Answered "no such flow", its test ran
    // on, in every status push, until the host restarted.
    [Fact]
    public async Task Deleting_a_flow_that_was_never_saved_is_404_and_takes_its_test_away()
    {
        Assert.Equal(HttpStatusCode.Accepted, (await _client.PostAsJsonAsync("/api/flows/draft/test", Waiting("draft"))).StatusCode);
        await Until(() => TestShown(_client, "draft"), "the test to be in the status");

        var response = await _client.DeleteAsync("/api/flows/draft");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("flowUnknown", (await Json(response)).GetProperty("reason").GetString());
        await Until(async () => !await TestShown(_client, "draft"), "the test to leave the status");
    }

    // Stop is how a forever test ends, and what it read on the way is what Test was pressed to see: the run is
    // kept, stopped, where it stood and with its counters. A second Stop finds no test going, and takes the
    // stopped one away.
    [Fact]
    public async Task Stopping_a_waiting_test_is_204_and_keeps_it_stopped_with_its_counters_and_stopping_it_again_is_404_and_takes_it_away()
    {
        Assert.Equal(HttpStatusCode.Accepted, (await _client.PostAsJsonAsync("/api/flows/held/test", Waiting("held"))).StatusCode);
        await Until(() => TestShown(_client, "held", "waiting"), "the test to wait for its message");

        Assert.Equal(HttpStatusCode.NoContent, (await _client.DeleteAsync("/api/flows/held/test")).StatusCode);
        await Until(() => TestShown(_client, "held", "stopped"), "the test to be shown stopped");

        var status = await Json(await _client.GetAsync("/api/flows/status"));
        var held = status.GetProperty("runs").EnumerateArray()
            .Single(run => run.GetProperty("flowId").GetString() == "held" && run.GetProperty("kind").GetString() == "test");
        Assert.Equal("in", held.GetProperty("at").GetString());
        Assert.Equal(JsonValueKind.Null, held.GetProperty("waiting").ValueKind);
        Assert.Equal(JsonValueKind.Null, held.GetProperty("fault").ValueKind);

        var start = held.GetProperty("nodes").EnumerateArray().Single(node => node.GetProperty("id").GetString() == "start");
        Assert.Equal(1, start.GetProperty("count").GetInt64());
        Assert.Equal(1, start.GetProperty("outs").GetProperty("out").GetInt64());
        var read = held.GetProperty("nodes").EnumerateArray().Single(node => node.GetProperty("id").GetString() == "in");
        Assert.Equal(1, read.GetProperty("count").GetInt64());

        var again = await _client.DeleteAsync("/api/flows/held/test");

        Assert.Equal(HttpStatusCode.NotFound, again.StatusCode);
        Assert.Equal("testUnknown", (await Json(again)).GetProperty("reason").GetString());
        await Until(async () => !await TestShown(_client, "held"), "the stopped test to leave the status");
    }

    // A test that has ended stays to be read until something takes it away. A stop does, and still answers
    // that no test was going.
    [Fact]
    public async Task Stopping_a_test_that_has_ended_is_404_and_takes_it_away()
    {
        var ending = new
        {
            id = "ended",
            name = "Ends",
            enabled = true,
            nodes = new[] { Node("start", "start"), Node("end", "end") },
            edges = new[] { Wire("e1", "start", "out", "end") },
        };
        Assert.Equal(HttpStatusCode.Accepted, (await _client.PostAsJsonAsync("/api/flows/ended/test", ending)).StatusCode);
        await Until(() => TestShown(_client, "ended", "finished"), "the test to finish");

        var response = await _client.DeleteAsync("/api/flows/ended/test");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("testUnknown", (await Json(response)).GetProperty("reason").GetString());
        await Until(async () => !await TestShown(_client, "ended"), "the ended test to leave the status");
    }

    // As many tests can run at once as flows can be kept, and one past that is refused as a save past its
    // limit is: in the PUT's shape, said of the flow as a whole.
    [Fact]
    public async Task A_fifty_first_test_going_is_a_400_said_of_the_flow()
    {
        using var fresh = new MqttForgeApiFactory();
        var client = fresh.CreateClient();
        var engine = fresh.Services.GetRequiredService<FlowEngine>();

        for (var i = 0; i < FlowLimits.Flows; i++)
            Assert.Equal(HttpStatusCode.Accepted, (await client.PostAsJsonAsync($"/api/flows/t{i}/test", Waiting($"t{i}"))).StatusCode);
        await Until(() => Task.FromResult(Enumerable.Range(0, FlowLimits.Flows).All(i => engine.IsTesting($"t{i}"))),
            "the fifty tests to be going");

        var response = await client.PostAsJsonAsync("/api/flows/more/test", Waiting("more"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await Json(response);
        Assert.Equal("flowInvalid", problem.GetProperty("reason").GetString());
        Assert.Equal("The flow was not tested", problem.GetProperty("title").GetString());
        Assert.Equal("At most 50 tests can run at once. Stop one first.", problem.GetProperty("errors").GetProperty("flow")[0].GetString());
    }
}
