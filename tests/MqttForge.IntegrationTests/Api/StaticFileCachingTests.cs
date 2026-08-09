using System.Net;
using MqttForge.IntegrationTests.Support;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

// index.html names the hashed bundles, so a cached copy of it pins the whole UI to an old build
public sealed class StaticFileCachingTests : IClassFixture<MqttForgeApiFactory>
{
    private readonly MqttForgeApiFactory _factory;

    public StaticFileCachingTests(MqttForgeApiFactory factory) => _factory = factory;

    [Fact]
    public async Task Index_is_revalidated_on_every_load()
    {
        var response = await _factory.CreateClient().GetAsync("/");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True(response.Headers.CacheControl?.NoCache, "index.html must not be served from cache unchecked");
    }

    // Their names change with their contents, so the old ones are never wrong to keep
    [Fact]
    public async Task Hashed_assets_are_cached_for_good()
    {
        var response = await _factory.CreateClient().GetAsync("/assets/" + await FirstAssetName());

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(TimeSpan.FromDays(365), response.Headers.CacheControl?.MaxAge);
    }

    private async Task<string> FirstAssetName()
    {
        var index = await _factory.CreateClient().GetStringAsync("/");
        var start = index.IndexOf("assets/", StringComparison.Ordinal) + "assets/".Length;
        var end = index.IndexOfAny(['"', '\''], start);

        return index[start..end];
    }
}
