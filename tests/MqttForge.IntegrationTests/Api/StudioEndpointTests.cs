using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MqttForge.IntegrationTests.Support;
using Xunit;

namespace MqttForge.IntegrationTests.Api;

// No broker: the studio never needs one.
public sealed class StudioEndpointTests : IClassFixture<MqttForgeApiFactory>
{
    private readonly MqttForgeApiFactory _factory;
    private readonly HttpClient _client;

    public StudioEndpointTests(MqttForgeApiFactory factory)
    {
        _factory = factory;
        _client = factory.CreateClient();
    }

    private static object Scene(string id, string name = "Cell 1", object[]? objects = null) => new
    {
        version = 2,
        id,
        name,
        updatedAt = "2000-01-01T00:00:00Z",
        settings = new { displayUnit = "mm", moveStep = 0.001, rotateStep = 1, snap = true },
        objects = objects ?? [new { id = "o1", type = "box", name = "Box", position = new[] { 0, 0.5, 0 } }],
        groups = Array.Empty<object>(),
        poses = Array.Empty<object>(),
        annotations = Array.Empty<object>(),
    };

    private static async Task<JsonElement> Json(HttpResponseMessage response) =>
        JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone();

    [Fact]
    public async Task A_saved_scene_is_listed_and_reads_back_with_a_server_stamp()
    {
        var put = await _client.PutAsJsonAsync("/api/studio/scenes/round1", Scene("round1"));
        Assert.Equal(HttpStatusCode.NoContent, put.StatusCode);

        var list = await Json(await _client.GetAsync("/api/studio/scenes"));
        var listed = list.EnumerateArray().Single(one => one.GetProperty("id").GetString() == "round1");
        Assert.Equal("Cell 1", listed.GetProperty("name").GetString());

        var scene = await Json(await _client.GetAsync("/api/studio/scenes/round1"));
        Assert.Equal("Box", scene.GetProperty("objects")[0].GetProperty("name").GetString());
        Assert.True(scene.GetProperty("updatedAt").GetDateTimeOffset() > DateTimeOffset.UtcNow.AddMinutes(-5));
    }

    [Fact]
    public async Task A_scene_whose_body_names_another_id_is_refused_with_its_reason()
    {
        var put = await _client.PutAsJsonAsync("/api/studio/scenes/one", Scene("two"));

        Assert.Equal(HttpStatusCode.BadRequest, put.StatusCode);
        var problem = await Json(put);
        Assert.Equal("sceneInvalid", problem.GetProperty("reason").GetString());
        Assert.True(problem.GetProperty("errors").TryGetProperty("id", out _));
    }

    [Fact]
    public async Task A_scene_with_no_name_or_an_old_version_is_refused()
    {
        var put = await _client.PutAsJsonAsync("/api/studio/scenes/v1", new { version = 1, id = "v1", name = " ", objects = Array.Empty<object>() });

        Assert.Equal(HttpStatusCode.BadRequest, put.StatusCode);
        var errors = (await Json(put)).GetProperty("errors");
        Assert.True(errors.TryGetProperty("version", out _));
        Assert.True(errors.TryGetProperty("name", out _));
    }

    [Fact]
    public async Task An_unknown_scene_is_a_404_that_says_so()
    {
        var get = await _client.GetAsync("/api/studio/scenes/missing");

        Assert.Equal(HttpStatusCode.NotFound, get.StatusCode);
        Assert.Equal("sceneUnknown", (await Json(get)).GetProperty("reason").GetString());
    }

    [Fact]
    public async Task Deleting_a_scene_takes_it_out_of_the_list()
    {
        await _client.PutAsJsonAsync("/api/studio/scenes/gone", Scene("gone"));

        Assert.Equal(HttpStatusCode.NoContent, (await _client.DeleteAsync("/api/studio/scenes/gone")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _client.DeleteAsync("/api/studio/scenes/gone")).StatusCode);
        var list = await Json(await _client.GetAsync("/api/studio/scenes"));
        Assert.DoesNotContain(list.EnumerateArray(), one => one.GetProperty("id").GetString() == "gone");
    }

    [Fact]
    public async Task An_uploaded_model_comes_back_by_its_key_cached_for_good()
    {
        var bytes = "solid cube\nendsolid cube\n"u8.ToArray();
        var post = await _client.PostAsync("/api/studio/models?ext=.stl", new ByteArrayContent(bytes));
        Assert.Equal(HttpStatusCode.OK, post.StatusCode);
        var key = (await Json(post)).GetProperty("key").GetString()!;
        Assert.EndsWith(".stl", key);

        var get = await _client.GetAsync($"/api/studio/models/{key}");
        Assert.Equal(HttpStatusCode.OK, get.StatusCode);
        Assert.Equal(bytes, await get.Content.ReadAsByteArrayAsync());
        Assert.Equal("model/stl", get.Content.Headers.ContentType?.MediaType);
        Assert.Equal(TimeSpan.FromDays(365), get.Headers.CacheControl?.MaxAge);
    }

    [Fact]
    public async Task A_model_of_a_kind_the_studio_does_not_keep_is_refused()
    {
        var post = await _client.PostAsync("/api/studio/models?ext=.exe", new ByteArrayContent([1, 2, 3]));

        Assert.Equal(HttpStatusCode.BadRequest, post.StatusCode);
        Assert.Equal("modelInvalid", (await Json(post)).GetProperty("reason").GetString());
    }

    [Fact]
    public async Task A_key_that_is_not_one_is_a_404()
    {
        var get = await _client.GetAsync("/api/studio/models/nothing.glb");

        Assert.Equal(HttpStatusCode.NotFound, get.StatusCode);
        Assert.Equal("modelUnknown", (await Json(get)).GetProperty("reason").GetString());
    }

    [Fact]
    public async Task Scenes_land_in_the_studio_folder_the_host_was_given()
    {
        await _client.PutAsJsonAsync("/api/studio/scenes/where", Scene("where"));

        Assert.True(File.Exists(Path.Combine(_factory.StudioPath, "scenes", "where.json")));
    }
}
