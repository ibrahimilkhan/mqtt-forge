using System.Net;
using System.Net.Http.Json;
using MqttForge.Api.Contracts;
using MqttForge.IntegrationTests.Support;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

// What survives a restart, and what a file nobody can read does to the endpoint.
public class ColourRulePersistenceTests : IDisposable
{
    private readonly string _settingsPath =
        Path.Combine(Path.GetTempPath(), $"mqttforge-api-{Guid.NewGuid():N}.json");

    private readonly string _colourRulesPath =
        Path.Combine(Path.GetTempPath(), $"mqttforge-colours-{Guid.NewGuid():N}.json");

    private MqttForgeApiFactory Host() => MqttForgeApiFactory.PointedAt(_settingsPath, _colourRulesPath);

    // The whole reason the rules live on the server rather than in a browser.
    [Fact]
    public async Task Rules_saved_by_one_run_are_there_for_the_next()
    {
        using (var first = Host())
        {
            var put = await first.CreateClient().PutAsJsonAsync(
                "/api/colour-rules",
                new ColourRulesDto([new ColourRuleDto("sensors/+/temp", "#b45309")]));
            put.EnsureSuccessStatusCode();
        }

        using var second = Host();
        var rules = await second.CreateClient().GetFromJsonAsync<ColourRulesDto>("/api/colour-rules");

        Assert.Equal([new ColourRuleDto("sensors/+/temp", "#b45309")], rules!.Rules);
    }

    [Fact]
    public async Task A_file_that_is_not_json_reads_as_no_rules_rather_than_failing()
    {
        await File.WriteAllTextAsync(_colourRulesPath, "{ half a file");

        using var host = Host();
        var response = await host.CreateClient().GetAsync("/api/colour-rules");

        response.EnsureSuccessStatusCode();
        var rules = await response.Content.ReadFromJsonAsync<ColourRulesDto>();
        Assert.Empty(rules!.Rules);
    }

    // Validation guards the way in, not the way out. A file edited past it is handed back as it
    // is — the console refuses the colour rather than putting it in a style attribute — and the
    // endpoint's job here is only to not fall over.
    [Fact]
    public async Task A_colour_edited_into_the_file_by_hand_does_not_break_the_endpoint()
    {
        await File.WriteAllTextAsync(
            _colourRulesPath,
            """[{"Filter":"sensors/#","Colour":"red; background: url(x)"}]""");

        using var host = Host();
        var response = await host.CreateClient().GetAsync("/api/colour-rules");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    // A saved list is the one that was sent, not the one before it plus an append.
    [Fact]
    public async Task The_file_holds_only_the_most_recent_list()
    {
        using var host = Host();
        var client = host.CreateClient();

        await client.PutAsJsonAsync(
            "/api/colour-rules",
            new ColourRulesDto([new ColourRuleDto("a/#", "#1e40af"), new ColourRuleDto("b/#", "#0d7a63")]));
        await client.PutAsJsonAsync(
            "/api/colour-rules",
            new ColourRulesDto([new ColourRuleDto("c/#", "#ab3520")]));

        var written = await File.ReadAllTextAsync(_colourRulesPath);
        Assert.Contains("c/#", written);
        Assert.DoesNotContain("a/#", written);
    }

    public void Dispose()
    {
        if (File.Exists(_settingsPath)) File.Delete(_settingsPath);
        if (File.Exists(_colourRulesPath)) File.Delete(_colourRulesPath);
    }
}
