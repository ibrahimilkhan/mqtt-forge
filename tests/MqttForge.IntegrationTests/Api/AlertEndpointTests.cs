using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using MqttForge.Api.Contracts;
using MqttForge.Application.Alerts;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using MqttForge.IntegrationTests.Support;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

// The rules survive a round trip, a damaged file is refused rather than overwritten, a secret
// never comes back out, and the panel's three verbs do what the panel needs them to do.
//
// A fresh factory per test, exactly as ColourRuleEndpointTests takes one and for the same reason:
// every test here writes the same stored list, xUnit promises no order within a class, and a
// shared file would make "starts empty" depend on which test ran first.
//
// No broker anywhere in this file. The alert engine's queue is the seam MQTTnet's receive loop
// posts to, so a reading handed straight to it is the same message the broker would have caused,
// minus a container and two seconds; HeadlessAlertingTests already proves the wire half end to
// end and there is nothing for a second copy of that proof to catch.
public class AlertEndpointTests : IDisposable
{
    private readonly MqttForgeApiFactory _factory = new();

    // Hosts pointed at a file this class wrote by hand, and the paths they were pointed at.
    // PointedAt deliberately does not delete what it did not create, so the cleaning is here.
    private readonly List<MqttForgeApiFactory> _extra = [];
    private readonly List<string> _files = [];

    public void Dispose()
    {
        _factory.Dispose();

        foreach (var factory in _extra) factory.Dispose();
        foreach (var path in _files)
            if (File.Exists(path))
                File.Delete(path);
    }

    /// <summary>A screen action, which is what a rule wants unless a test says otherwise.</summary>
    private static readonly AlertActionDto Screen =
        new("screen", Url: null, Headers: null, HeaderNames: null, Topic: null, Qos: null, Retain: null);

    private const string Hook = "http://example.invalid/hook";

    private static AlertActionDto Webhook(string url, params (string Name, string Value)[] headers) =>
        new("webhook", url,
            headers.ToDictionary(header => header.Name, header => header.Value, StringComparer.Ordinal),
            HeaderNames: null, Topic: null, Qos: null, Retain: null);

    private static AlertRuleDto Hot(string? id = null, string filter = "plant/+/temp",
                                    params AlertActionDto[] actions) =>
        new(id, "Boiler temperature", Enabled: true, filter, Field: null,
            new ThresholdCondition(ThresholdOp.Gt, 90), Clear: null, For: null, Cooldown: null,
            AlertSeverity.Warn, actions.Length == 0 ? [Screen] : actions);

    private static Task<HttpResponseMessage> PutAsync(
        HttpClient client, string query, params AlertRuleDto[] rules) =>
        client.PutAsJsonAsync($"/api/alert-rules{query}", new AlertRulesDto(rules), WireJson.Client);

    private static async Task<AlertRulesResponseDto> RulesAsync(HttpClient client)
    {
        var response = await client.GetAsync("/api/alert-rules");

        response.EnsureSuccessStatusCode();

        return (await response.Content.ReadFromJsonAsync<AlertRulesResponseDto>(WireJson.Client))!;
    }

    private static async Task<AlertsDto> AlertsAsync(HttpClient client)
    {
        var response = await client.GetAsync("/api/alerts");

        response.EnsureSuccessStatusCode();

        return (await response.Content.ReadFromJsonAsync<AlertsDto>(WireJson.Client))!;
    }

    /// <summary>The `reason` a problem document carries, which is the word the console reads.</summary>
    // Read out of the raw JSON rather than off a typed DTO: `reason` is an extension member, it
    // sits at the top level beside `title` and `status`, and ProblemDetails.Extensions is exactly
    // the part a strongly typed read would drop on the floor.
    private static async Task<string?> ReasonAsync(HttpResponseMessage response)
    {
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());

        return document.RootElement.TryGetProperty("reason", out var reason) ? reason.GetString() : null;
    }

    private string Temp(string what)
    {
        var path = Path.Combine(Path.GetTempPath(), $"mqttforge-alert-endpoint-{what}-{Guid.NewGuid():N}.json");
        _files.Add(path);

        return path;
    }

    /// <summary>A host whose alert rules file already holds something no build can read.</summary>
    // Written before the host is built, because the engine reads that file once on start-up and
    // the whole point of these two tests is what the endpoints say about a file that was already
    // damaged when the process found it.
    private HttpClient Damaged()
    {
        var rules = Temp("broken");
        File.WriteAllText(rules, "{ this is not json");

        var factory = MqttForgeApiFactory.PointedAt(
            Temp("settings"), Temp("colours"), Temp("brokers"), rules, Temp("state"));

        _extra.Add(factory);

        return factory.CreateClient();
    }

    /// <summary>One reading, straight into the engine this host is running.</summary>
    private void Reading(string topic, string payload) =>
        _factory.Services.GetRequiredService<AlertEngine>().Post(
            new ArrivalCommand(new MqttMessage(topic, payload, "text", 0, false, DateTimeOffset.UtcNow)));

    /// <summary>Polls the endpoint until it says something, or says what it was waiting for.</summary>
    // The pump and the supervisor are background loops with a one-second tick, so there is nothing
    // to await: a save, a mute and a history clear are all posted to a queue and answered before
    // the engine has read them. The same shape HeadlessAlertingTests uses, over HTTP.
    private static async Task<T> Until<T>(Func<Task<T>> read, Func<T, bool> ready, string what)
    {
        var deadline = DateTime.UtcNow.AddSeconds(20);

        while (DateTime.UtcNow < deadline)
        {
            var value = await read();
            if (ready(value)) return value;

            await Task.Delay(50);
        }

        throw new TimeoutException($"Timed out after 20 seconds waiting for {what}.");
    }

    [Fact]
    public async Task Rules_start_empty_and_the_answer_carries_the_hosts_own_configuration()
    {
        var client = _factory.CreateClient();

        var body = await RulesAsync(client);

        Assert.Empty(body.Rules);
        Assert.False(body.Unreadable);
        Assert.Empty(body.SkippedIds);

        // Both of these are things only the server knows, and the console is asked in the spec to
        // draw behaviour from them — "webhooks are off on this host", "your publish topic has to
        // start with this". Without them on this document those sentences have no carrier.
        // The factory turns webhooks off for the whole suite, which is what makes this a real
        // assertion rather than a reading of the shipped default.
        Assert.False(body.AllowWebhooks);
        Assert.Equal("mqttforge/alerts/", body.TopicPrefix);
    }

    [Fact]
    public async Task Saved_rules_are_read_back()
    {
        var client = _factory.CreateClient();

        var put = await PutAsync(client, "", Hot("hot"));

        Assert.Equal(HttpStatusCode.OK, put.StatusCode);
        var saved = await put.Content.ReadFromJsonAsync<AlertRulesSavedDto>(WireJson.Client);
        Assert.Equal("hot", Assert.Single(saved!.Rules).Id);
        Assert.Empty(saved.Warnings);

        var rule = Assert.Single((await RulesAsync(client)).Rules);

        Assert.Equal("hot", rule.Id);
        Assert.Equal("Boiler temperature", rule.Name);
        Assert.True(rule.Enabled);
        Assert.Equal("plant/+/temp", rule.Filter);
        Assert.Equal(AlertSeverity.Warn, rule.Severity);

        // The condition and not just its shape: this is the one member of the document that goes
        // out and comes back as a polymorphic union, and a discriminator that failed to survive
        // the round trip would read here as a threshold that lost its number.
        Assert.Equal(new ThresholdCondition(ThresholdOp.Gt, 90), rule.Condition);
    }

    [Fact]
    public async Task A_rule_that_arrives_with_no_id_is_given_one()
    {
        var client = _factory.CreateClient();

        var put = await PutAsync(client, "", Hot(id: null));

        var saved = await put.Content.ReadFromJsonAsync<AlertRulesSavedDto>(WireJson.Client);
        var id = Assert.Single(saved!.Rules).Id;

        Assert.False(string.IsNullOrWhiteSpace(id));

        // The same id the file now holds, which is what makes the answer worth returning: the
        // console's next save carries this id, and a server that handed back an id it had not
        // written down would turn every edit of a new rule into a second rule.
        Assert.Equal(id, Assert.Single((await RulesAsync(client)).Rules).Id);
    }

    [Fact]
    public async Task A_rule_left_out_of_a_later_put_is_gone()
    {
        var client = _factory.CreateClient();
        await PutAsync(client, "", Hot("hot"), Hot("cold", "plant/+/pressure"));

        await PutAsync(client, "", Hot("cold", "plant/+/pressure"));

        Assert.Equal("cold", Assert.Single((await RulesAsync(client)).Rules).Id);
    }

    [Theory]
    [InlineData("a/#/b")]
    [InlineData("")]
    public async Task A_malformed_filter_is_refused(string filter)
    {
        var client = _factory.CreateClient();

        var response = await PutAsync(client, "", Hot("hot", filter));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("application/problem+json", response.Content.Headers.ContentType?.MediaType);

        // And nothing was written. A rule set refused at the boundary that had already replaced
        // the file would be the worst of both answers.
        Assert.Empty((await RulesAsync(client)).Rules);
    }

    [Fact]
    public async Task An_unreadable_file_answers_409_rather_than_an_empty_list()
    {
        var client = Damaged();

        var response = await client.GetAsync("/api/alert-rules");

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Contains("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal("rulesUnreadable", await ReasonAsync(response));
    }

    [Fact]
    public async Task A_save_over_an_unreadable_file_is_refused_until_it_is_asked_for()
    {
        var client = Damaged();

        var refused = await PutAsync(client, "", Hot("hot"));

        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        Assert.Equal("rulesUnreadable", await ReasonAsync(refused));

        var allowed = await PutAsync(client, "?discardUnreadable=true", Hot("hot"));

        Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
        Assert.Equal("hot", Assert.Single((await RulesAsync(client)).Rules).Id);
    }

    [Fact]
    public async Task A_webhooks_headers_never_come_back_out()
    {
        var client = _factory.CreateClient();
        await PutAsync(client, "", Hot("hot", "plant/+/temp", Webhook(Hook, ("Authorization", "Bearer secret"))));

        var action = Assert.Single(Assert.Single((await RulesAsync(client)).Rules).Actions);

        Assert.Equal("webhook", action.Type);
        Assert.Equal(Hook, action.Url);
        Assert.Null(action.Headers);
        Assert.Equal("Authorization", Assert.Single(action.HeaderNames!));

        // The DTO could be right and the response still wrong — an extra member, a serialiser
        // writing the domain object somewhere. SECURITY.md's promise is about the bytes.
        Assert.DoesNotContain("Bearer secret", await client.GetStringAsync("/api/alert-rules"));
    }

    [Fact]
    public async Task A_header_name_with_no_value_keeps_what_is_already_on_disk()
    {
        var client = _factory.CreateClient();
        await PutAsync(client, "", Hot("hot", "plant/+/temp", Webhook(Hook, ("Authorization", "Bearer secret"))));

        // What a console that was only ever shown the names can send back.
        await PutAsync(client, "", Hot("hot", "plant/+/temp", Webhook(Hook, ("Authorization", ""))));

        // Read off the file, because the API is not allowed to show it and that is the point.
        Assert.Contains("Bearer secret", await File.ReadAllTextAsync(_factory.AlertRulesPath));
    }

    [Fact]
    public async Task A_kept_header_is_not_carried_to_an_address_it_was_never_given_for()
    {
        var client = _factory.CreateClient();
        await PutAsync(client, "", Hot("hot", "plant/+/temp", Webhook(Hook, ("Authorization", "Bearer secret"))));

        await PutAsync(client, "", Hot("hot", "plant/+/temp",
            Webhook("http://somewhere.invalid/else", ("Authorization", ""))));

        // Moving the URL and keeping the token by name would post somebody's credential to an
        // address they never gave it to. The name comes back with nothing behind it instead.
        var onDisk = await File.ReadAllTextAsync(_factory.AlertRulesPath);

        Assert.DoesNotContain("Bearer secret", onDisk);
        Assert.Contains("somewhere.invalid", onDisk);
    }

    [Fact]
    public async Task A_webhook_on_a_host_that_will_not_send_one_is_a_warning_and_not_a_refusal()
    {
        var client = _factory.CreateClient();

        var put = await PutAsync(client, "", Hot("hot", "plant/+/temp", Webhook(Hook)));

        // Allowed, and said so: "permitted but warned" is not FluentValidation's job, and a
        // validator written naively here would refuse the save outright.
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);

        var saved = await put.Content.ReadFromJsonAsync<AlertRulesSavedDto>(WireJson.Client);
        var warning = Assert.Single(saved!.Warnings);

        Assert.Equal("hot", warning.RuleId);
        Assert.Equal("webhooksDisabled", warning.Reason);
        Assert.Single(saved.Rules);
    }

    [Fact]
    public async Task Alerts_start_empty_and_count_the_seconds_the_engine_has_been_blind()
    {
        var client = _factory.CreateClient();

        // No broker was ever dialled by this host, so the engine cannot see anything and the
        // number climbs. Waiting for the first whole second is what proves it is read off a clock
        // rather than shipped as a zero.
        var alerts = await Until(() => AlertsAsync(client), panel => panel.BlindSeconds >= 1,
            "the panel to count the seconds the engine has been blind");

        Assert.Empty(alerts.Active);
        Assert.Empty(alerts.History);
        Assert.Empty(alerts.Muted);
        Assert.Empty(alerts.Rules);
        Assert.Empty(alerts.Capped);
        Assert.Equal(0, alerts.Dropped);
        Assert.Equal(0, alerts.WebhooksDropped);
        Assert.Equal(0, alerts.Suppressed);
    }

    [Fact]
    public async Task A_rules_row_says_what_the_rule_has_seen()
    {
        var client = _factory.CreateClient();
        await PutAsync(client, "", Hot("hot"));

        // Under the line: judged, and no alarm. A quiet rule and a rule that matched no topic at
        // all look identical without this row, which is the whole reason it exists.
        Reading("plant/boiler/temp", "20.1");

        var alerts = await Until(() => AlertsAsync(client),
            panel => panel.Rules.Count == 1 && panel.Rules[0].Evaluated > 0,
            "the rule's own row to fill in");

        var row = Assert.Single(alerts.Rules);

        Assert.Equal("hot", row.RuleId);
        Assert.Equal(1, row.Topics);
        Assert.Equal(0, row.Skipped);
        Assert.False(row.Faulted);
        Assert.Null(row.FaultReason);
        Assert.Empty(alerts.Active);
    }

    [Fact]
    public async Task Muting_a_pair_silences_it_without_ending_the_alarm()
    {
        var client = _factory.CreateClient();
        await PutAsync(client, "", Hot("hot"));
        Reading("plant/boiler/temp", "94.2");
        await Until(() => AlertsAsync(client), panel => panel.Active.Count == 1, "the alarm to reach the panel");

        var mute = await client.PostAsJsonAsync(
            "/api/alerts/mute", new MuteRequestDto("hot", "plant/boiler/temp", 30), WireJson.Client);

        Assert.Equal(HttpStatusCode.NoContent, mute.StatusCode);

        var alerts = await Until(() => AlertsAsync(client), panel => panel.Muted.Count == 1,
            "the mute to be applied");

        var pair = Assert.Single(alerts.Muted);
        Assert.Equal("hot", pair.RuleId);
        Assert.Equal("plant/boiler/temp", pair.Topic);

        // Still ringing, and still counting. Muting means "stop telling me", not "forget the
        // condition" — an alarm that vanished when it was silenced would be a lie on the panel.
        var alert = Assert.Single(alerts.Active);
        Assert.Equal("plant/boiler/temp", alert.Topic);
        Assert.NotNull(alert.MutedUntil);
    }

    [Fact]
    public async Task Zero_minutes_lifts_the_mute()
    {
        var client = _factory.CreateClient();
        await PutAsync(client, "", Hot("hot"));
        Reading("plant/boiler/temp", "94.2");
        await Until(() => AlertsAsync(client), panel => panel.Active.Count == 1, "the alarm to reach the panel");

        await client.PostAsJsonAsync(
            "/api/alerts/mute", new MuteRequestDto("hot", "plant/boiler/temp", 30), WireJson.Client);
        await Until(() => AlertsAsync(client), panel => panel.Muted.Count == 1, "the mute to be applied");

        var lifted = await client.PostAsJsonAsync(
            "/api/alerts/mute", new MuteRequestDto("hot", "plant/boiler/temp", 0), WireJson.Client);

        Assert.Equal(HttpStatusCode.NoContent, lifted.StatusCode);

        var alerts = await Until(() => AlertsAsync(client), panel => panel.Muted.Count == 0,
            "the mute to be lifted");

        Assert.Null(Assert.Single(alerts.Active).MutedUntil);
    }

    [Fact]
    public async Task Muting_a_pair_the_engine_has_never_seen_is_a_404()
    {
        var client = _factory.CreateClient();
        await PutAsync(client, "", Hot("hot"));

        var response = await client.PostAsJsonAsync(
            "/api/alerts/mute", new MuteRequestDto("hot", "plant/nobody/temp", 30), WireJson.Client);

        // The core drops a mute for a pair it does not hold and says nothing — deliberately, so
        // that a console muting a row the rules have just edited away cannot fault the pump. That
        // silence is right in there and wrong out here: the console pressed a button and has to
        // be told the row it was pressing is gone.
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Contains("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal("alertUnknown", await ReasonAsync(response));
    }

    [Fact]
    public async Task Clearing_the_history_leaves_the_alarm_that_is_still_ringing()
    {
        var client = _factory.CreateClient();
        await PutAsync(client, "", Hot("hot"));

        Reading("plant/boiler/temp", "94.2");
        Reading("plant/pump/temp", "94.2");
        await Until(() => AlertsAsync(client), panel => panel.Active.Count == 2, "both alarms to ring");

        // One of the two comes back under the line and closes, which is the only way anything
        // reaches the history at all.
        Reading("plant/boiler/temp", "20.1");
        await Until(() => AlertsAsync(client), panel => panel.History.Count == 1, "the boiler to recover");

        var cleared = await client.DeleteAsync("/api/alerts/history");

        Assert.Equal(HttpStatusCode.NoContent, cleared.StatusCode);

        var alerts = await Until(() => AlertsAsync(client), panel => panel.History.Count == 0,
            "the history to empty");

        // The present is not history. A user tidying away a list of things that finished must not
        // find the thing that is still happening has gone with them.
        Assert.Equal("plant/pump/temp", Assert.Single(alerts.Active).Topic);
    }
}
