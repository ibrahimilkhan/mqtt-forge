using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using MqttForge.Application.Services;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application;

public sealed class StudioServiceTests
{
    private const string KeyA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.glb";
    private const string KeyB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.stl";

    private static JsonElement Scene(string id, params string[] modelKeys) => JsonSerializer.SerializeToElement(new
    {
        version = 2,
        id,
        name = "Cell",
        updatedAt = "2000-01-01T00:00:00+00:00",
        objects = modelKeys.Select((key, i) => new { id = $"o{i}", type = "model", model = new { key, ext = Path.GetExtension(key) } }),
    });

    private sealed class Scenes : IStudioSceneStore
    {
        public readonly Dictionary<string, JsonElement> Saved = [];
        public bool Unreadable;

        public Task<IReadOnlyList<StudioSceneSummary>> ListAsync(CancellationToken ct) => throw new NotSupportedException();
        public Task<JsonElement?> GetAsync(string id, CancellationToken ct) =>
            Task.FromResult(Saved.TryGetValue(id, out var d) ? d : (JsonElement?)null);
        public Task SaveAsync(string id, JsonElement document, CancellationToken ct) { Saved[id] = document; return Task.CompletedTask; }
        public Task<bool> DeleteAsync(string id, CancellationToken ct) => Task.FromResult(Saved.Remove(id));
        public Task<StudioSceneSet> ReadAllAsync(CancellationToken ct) => Task.FromResult(new StudioSceneSet([.. Saved.Values], Unreadable));
    }

    private sealed class Models : IStudioModelStore
    {
        public IReadOnlySet<string>? Kept;
        public Task<string> PutAsync(Stream content, string extension, CancellationToken ct) => Task.FromResult(KeyA);
        public Stream? OpenRead(string key) => null;
        public int DeleteUnused(IReadOnlySet<string> keep, TimeSpan grace) { Kept = keep; return 0; }
    }

    [Fact]
    public async Task A_save_is_stamped_with_the_server_s_time_not_the_console_s()
    {
        var scenes = new Scenes();
        var service = new StudioService(scenes, new Models(), NullLogger<StudioService>.Instance);
        var now = new DateTimeOffset(2026, 11, 13, 12, 0, 0, TimeSpan.Zero);

        await service.SaveAsync("s1", Scene("s1"), now, CancellationToken.None);

        Assert.Equal(now, scenes.Saved["s1"].GetProperty("updatedAt").GetDateTimeOffset());
        Assert.Equal("Cell", scenes.Saved["s1"].GetProperty("name").GetString());
    }

    [Fact]
    public async Task Every_model_any_scene_names_is_kept_when_collecting()
    {
        var scenes = new Scenes();
        var models = new Models();
        var service = new StudioService(scenes, models, NullLogger<StudioService>.Instance);

        await service.SaveAsync("s1", Scene("s1", KeyA), DateTimeOffset.UtcNow, CancellationToken.None);
        await service.SaveAsync("s2", Scene("s2", KeyB), DateTimeOffset.UtcNow, CancellationToken.None);

        Assert.Equal(new HashSet<string> { KeyA, KeyB }, models.Kept);
    }

    [Fact]
    public async Task Nothing_is_collected_while_any_scene_cannot_be_read()
    {
        var scenes = new Scenes { Unreadable = true };
        var models = new Models();
        var service = new StudioService(scenes, models, NullLogger<StudioService>.Instance);

        await service.SaveAsync("s1", Scene("s1"), DateTimeOffset.UtcNow, CancellationToken.None);

        Assert.Null(models.Kept);
    }

    [Fact]
    public async Task Deleting_a_scene_collects_and_says_whether_there_was_one()
    {
        var scenes = new Scenes();
        var models = new Models();
        var service = new StudioService(scenes, models, NullLogger<StudioService>.Instance);
        await service.SaveAsync("s1", Scene("s1", KeyA), DateTimeOffset.UtcNow, CancellationToken.None);

        Assert.True(await service.DeleteAsync("s1", CancellationToken.None));
        Assert.Empty(models.Kept!);
        Assert.False(await service.DeleteAsync("s1", CancellationToken.None));
    }

    [Fact]
    public void Model_keys_skip_objects_without_a_model_and_odd_shapes()
    {
        var document = JsonSerializer.SerializeToElement(new
        {
            objects = new object[]
            {
                new { id = "a", type = "box" },
                new { id = "b", type = "model", model = new { key = KeyA } },
                new { id = "c", type = "model", model = "not an object" },
            },
        });

        Assert.Equal([KeyA], StudioService.ModelKeys(document));
    }
}
