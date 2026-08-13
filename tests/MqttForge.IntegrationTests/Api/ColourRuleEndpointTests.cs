using System.Net;
using System.Net.Http.Json;
using MqttForge.Api.Contracts;
using MqttForge.IntegrationTests.Support;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

// The rules survive a round trip and nothing malformed gets past the boundary.
//
// A fresh factory per test rather than a shared fixture: every test here writes the same stored
// list, and xUnit gives no order within a class — a shared file would make "starts empty" depend
// on which test ran first. No broker is involved, so a host per test is cheap.
public class ColourRuleEndpointTests : IDisposable
{
    private readonly MqttForgeApiFactory _factory = new();

    public void Dispose() => _factory.Dispose();

    private static ColourRulesDto Rules(params (string Filter, string Colour)[] rules) =>
        new([.. rules.Select(rule => new ColourRuleDto(rule.Filter, rule.Colour))]);

    [Fact]
    public async Task Rules_start_empty()
    {
        var client = _factory.CreateClient();

        var response = await client.GetAsync("/api/colour-rules");

        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<ColourRulesDto>();
        Assert.Empty(body!.Rules);
    }

    [Fact]
    public async Task Saved_rules_are_read_back()
    {
        var client = _factory.CreateClient();
        var sent = Rules(("sensors/+/temp", "#b45309"), ("alerts/#", "#ab3520"));

        var put = await client.PutAsJsonAsync("/api/colour-rules", sent);
        Assert.Equal(HttpStatusCode.NoContent, put.StatusCode);

        var body = await client.GetFromJsonAsync<ColourRulesDto>("/api/colour-rules");
        Assert.Equal(sent.Rules, body!.Rules);
    }

    [Fact]
    public async Task A_put_replaces_the_whole_list()
    {
        var client = _factory.CreateClient();
        await client.PutAsJsonAsync("/api/colour-rules", Rules(("a/#", "#1e40af"), ("b/#", "#0d7a63")));

        await client.PutAsJsonAsync("/api/colour-rules", Rules(("c/#", "#ab3520")));

        var body = await client.GetFromJsonAsync<ColourRulesDto>("/api/colour-rules");
        Assert.Equal([new ColourRuleDto("c/#", "#ab3520")], body!.Rules);
    }

    [Fact]
    public async Task An_empty_list_clears_the_rules()
    {
        var client = _factory.CreateClient();
        await client.PutAsJsonAsync("/api/colour-rules", Rules(("a/#", "#1e40af")));

        var put = await client.PutAsJsonAsync("/api/colour-rules", Rules());

        Assert.Equal(HttpStatusCode.NoContent, put.StatusCode);
        var body = await client.GetFromJsonAsync<ColourRulesDto>("/api/colour-rules");
        Assert.Empty(body!.Rules);
    }

    [Theory]
    [InlineData("red")]
    [InlineData("#fff")]
    [InlineData("#b45309; background: url(x)")]
    public async Task A_colour_that_is_not_a_hex_triple_is_refused(string colour)
    {
        var client = _factory.CreateClient();

        var response = await client.PutAsJsonAsync("/api/colour-rules", Rules(("sensors/#", colour)));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("application/problem+json", response.Content.Headers.ContentType?.MediaType);
    }

    [Theory]
    [InlineData("a/#/b")]
    [InlineData("a/b+")]
    [InlineData("")]
    public async Task A_malformed_filter_is_refused(string filter)
    {
        var client = _factory.CreateClient();

        var response = await client.PutAsJsonAsync("/api/colour-rules", Rules((filter, "#b45309")));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task The_same_filter_twice_is_refused()
    {
        var client = _factory.CreateClient();

        var response = await client.PutAsJsonAsync(
            "/api/colour-rules", Rules(("sensors/#", "#b45309"), ("sensors/#", "#1e40af")));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task More_than_a_hundred_rules_are_refused()
    {
        var client = _factory.CreateClient();
        var rules = Enumerable.Range(0, 101).Select(i => ($"topic/{i}", "#1e40af")).ToArray();

        var response = await client.PutAsJsonAsync("/api/colour-rules", Rules(rules));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // A refused PUT must not have touched what was already stored.
    [Fact]
    public async Task A_refused_put_leaves_the_stored_rules_alone()
    {
        var client = _factory.CreateClient();
        await client.PutAsJsonAsync("/api/colour-rules", Rules(("keep/#", "#0d7a63")));

        await client.PutAsJsonAsync("/api/colour-rules", Rules(("sensors/#", "not-a-colour")));

        var body = await client.GetFromJsonAsync<ColourRulesDto>("/api/colour-rules");
        Assert.Equal([new ColourRuleDto("keep/#", "#0d7a63")], body!.Rules);
    }
}
