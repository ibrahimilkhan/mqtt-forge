using System.Net;
using System.Net.Http.Json;
using MqttForge.Api;
using MqttForge.Api.Contracts;
using MqttForge.IntegrationTests.Support;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

/// <summary>The supervisor, across the boundary and back.</summary>
// A fresh factory per test: every one of these writes the same option file, and xUnit gives no
// order within a class — a shared file would make "on unless somebody said otherwise" depend on
// which test ran first. No broker is involved, so a host per test is cheap.
public class ReconnectEndpointTests : IDisposable
{
    private readonly MqttForgeApiFactory _factory = new();

    public void Dispose() => _factory.Dispose();

    private const string Route = "/api/connection/reconnect";

    /// <summary>The status an answer carried, which every one of the three writes sends back.</summary>
    private static async Task<ReconnectStatusDto> StatusOf(HttpResponseMessage response)
    {
        response.EnsureSuccessStatusCode();

        return await response.Content.ReadFromJsonAsync<ReconnectStatusDto>()
               ?? throw new InvalidOperationException("no status in the answer");
    }

    private async Task<ReconnectStatusDto> GetStatusAsync(HttpClient client) =>
        await client.GetFromJsonAsync<ReconnectStatusDto>(Route)
        ?? throw new InvalidOperationException("no status in the answer");

    [Fact]
    public async Task Supervision_is_on_unless_somebody_said_otherwise()
    {
        var status = await GetStatusAsync(_factory.CreateClient());

        Assert.True(status.Enabled);
        Assert.True(BrokerLinkSupervisor.EnabledByDefault);
    }

    // A host with no enabled rule and no connection is not in an outage, and the panel has to be
    // able to tell that apart from an outage nobody is working on.
    [Fact]
    public async Task A_quiet_host_is_not_working_on_anything()
    {
        var status = await GetStatusAsync(_factory.CreateClient());

        Assert.False(status.Active);
        Assert.False(status.GaveUp);
        Assert.Equal(0, status.Attempt);
        Assert.Null(status.NextAttemptAt);
    }

    [Fact]
    public async Task The_option_can_be_turned_off_and_comes_back_off()
    {
        var client = _factory.CreateClient();

        var put = await client.PutAsJsonAsync(Route, new ReconnectOptionDto(false));

        Assert.False((await StatusOf(put)).Enabled);
        Assert.False((await GetStatusAsync(client)).Enabled);
    }

    // The file, not the memory. A container that came back up having been told not to supervise
    // and supervised anyway would be ignoring the one thing it was asked to remember.
    [Fact]
    public async Task The_option_outlives_the_process()
    {
        var client = _factory.CreateClient();
        await client.PutAsJsonAsync(Route, new ReconnectOptionDto(false));

        await using var restarted = MqttForgeApiFactory.PointedAt(
            _factory.SettingsPath, _factory.ColourRulesPath, _factory.SavedProfilesPath,
            _factory.AlertRulesPath, _factory.AlertStatePath, _factory.ReconnectPath);

        Assert.False((await GetStatusAsync(restarted.CreateClient())).Enabled);
    }

    // Defaulting a missing answer either way would let a malformed request quietly turn
    // supervision off, which is the one outcome nobody would notice until a broker dropped.
    [Fact]
    public async Task A_body_with_no_answer_in_it_is_refused()
    {
        var client = _factory.CreateClient();

        var put = await client.PutAsJsonAsync(Route, new { });

        Assert.Equal(HttpStatusCode.BadRequest, put.StatusCode);
        Assert.True((await GetStatusAsync(client)).Enabled);
    }

    [Fact]
    public async Task Calling_off_an_outage_is_answered_with_the_status_it_made()
    {
        var client = _factory.CreateClient();

        var stopped = await client.DeleteAsync(Route);

        var status = await StatusOf(stopped);
        Assert.True(status.GaveUp);
        Assert.False(status.Active);
        // And the option is untouched, which is the whole difference between this and PUT false.
        Assert.True(status.Enabled);
    }

    // Nothing saved to dial, so the dial is a no-op and the point is that it answers rather
    // than throwing: a console pressing Try now on a host that has never connected gets a status
    // back and a log line, not a 500.
    [Fact]
    public async Task Trying_now_answers_even_when_there_is_nothing_to_dial()
    {
        var client = _factory.CreateClient();

        var tried = await client.PostAsync(Route, content: null);

        Assert.Equal(HttpStatusCode.OK, tried.StatusCode);
        Assert.False((await StatusOf(tried)).Active);
    }

    [Fact]
    public async Task Trying_now_takes_back_a_giving_up()
    {
        var client = _factory.CreateClient();
        await client.DeleteAsync(Route);
        Assert.True((await GetStatusAsync(client)).GaveUp);

        await client.PostAsync(Route, content: null);

        Assert.False((await GetStatusAsync(client)).GaveUp);
    }

    [Fact]
    public async Task Turning_the_option_back_on_takes_back_a_giving_up()
    {
        var client = _factory.CreateClient();
        await client.DeleteAsync(Route);

        await client.PutAsJsonAsync(Route, new ReconnectOptionDto(true));

        var status = await GetStatusAsync(client);
        Assert.False(status.GaveUp);
        Assert.True(status.Enabled);
    }

    // The endpoints and the supervisor are the same object. Registered the other way round — a
    // second instance for the controller — every one of these would pass against a supervisor
    // that supervises nothing.
    [Fact]
    public async Task The_endpoints_hold_the_supervisor_that_is_actually_running()
    {
        var client = _factory.CreateClient();
        await client.PutAsJsonAsync(Route, new ReconnectOptionDto(false));

        var running = _factory.Services.GetService(typeof(BrokerLinkSupervisor)) as BrokerLinkSupervisor;

        Assert.NotNull(running);
        Assert.False(running.Status.Enabled);
    }
}
