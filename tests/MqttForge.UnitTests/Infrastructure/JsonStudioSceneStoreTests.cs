using System.Text.Json;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Persistence;

namespace MqttForge.UnitTests.Infrastructure;

public sealed class JsonStudioSceneStoreTests : IDisposable
{
    private readonly string _directory =
        Path.Combine(Path.GetTempPath(), $"mqttforge-studio-{Guid.NewGuid():N}");

    public void Dispose()
    {
        if (Directory.Exists(_directory)) Directory.Delete(_directory, recursive: true);
    }

    private static JsonElement Scene(string id, string name = "Cell 1", string updatedAt = "2026-11-13T10:00:00+00:00") =>
        JsonSerializer.SerializeToElement(new { version = 2, id, name, updatedAt, objects = Array.Empty<object>() });

    [Fact]
    public async Task No_directory_lists_no_scenes()
    {
        Assert.Empty(await new JsonStudioSceneStore(_directory).ListAsync(CancellationToken.None));
    }

    [Fact]
    public async Task A_saved_scene_comes_back_as_it_went_in_and_is_listed()
    {
        var store = new JsonStudioSceneStore(_directory);

        await store.SaveAsync("a1", Scene("a1"), CancellationToken.None);

        var back = await store.GetAsync("a1", CancellationToken.None);
        Assert.NotNull(back);
        Assert.Equal("Cell 1", back.Value.GetProperty("name").GetString());
        var summary = Assert.Single(await store.ListAsync(CancellationToken.None));
        Assert.Equal(new StudioSceneSummary("a1", "Cell 1", DateTimeOffset.Parse("2026-11-13T10:00:00+00:00")), summary);
        Assert.True(File.Exists(Path.Combine(_directory, "scenes", "a1.json")));
        Assert.False(File.Exists(Path.Combine(_directory, "scenes", "a1.json.tmp")));
    }

    [Fact]
    public async Task An_unknown_scene_is_null_and_deleting_it_is_false()
    {
        var store = new JsonStudioSceneStore(_directory);

        Assert.Null(await store.GetAsync("nope", CancellationToken.None));
        Assert.False(await store.DeleteAsync("nope", CancellationToken.None));
    }

    [Fact]
    public async Task Deleting_a_scene_removes_its_file()
    {
        var store = new JsonStudioSceneStore(_directory);
        await store.SaveAsync("a1", Scene("a1"), CancellationToken.None);

        Assert.True(await store.DeleteAsync("a1", CancellationToken.None));
        Assert.Null(await store.GetAsync("a1", CancellationToken.None));
    }

    [Fact]
    public async Task A_broken_file_is_left_out_of_the_list_and_marks_the_set_unreadable()
    {
        var store = new JsonStudioSceneStore(_directory);
        await store.SaveAsync("good", Scene("good"), CancellationToken.None);
        await File.WriteAllTextAsync(Path.Combine(_directory, "scenes", "bad.json"), "{ not json");

        var listed = await store.ListAsync(CancellationToken.None);
        var all = await store.ReadAllAsync(CancellationToken.None);

        Assert.Equal("good", Assert.Single(listed).Id);
        Assert.Single(all.Documents);
        Assert.True(all.AnyUnreadable);
    }

    [Fact]
    public async Task Reading_a_broken_scene_says_so_rather_than_answering_nothing()
    {
        Directory.CreateDirectory(Path.Combine(_directory, "scenes"));
        await File.WriteAllTextAsync(Path.Combine(_directory, "scenes", "bad.json"), "{ not json");

        await Assert.ThrowsAsync<StudioSceneUnreadableException>(
            () => new JsonStudioSceneStore(_directory).GetAsync("bad", CancellationToken.None));
    }

    [Theory]
    [InlineData("../escape")]
    [InlineData("a/b")]
    [InlineData("")]
    public async Task An_id_that_could_leave_the_folder_is_refused(string id)
    {
        await Assert.ThrowsAsync<ArgumentException>(
            () => new JsonStudioSceneStore(_directory).SaveAsync(id, Scene("x"), CancellationToken.None));
    }

    [Theory]
    [InlineData("abc_DEF-123", true)]
    [InlineData("../x", false)]
    [InlineData(null, false)]
    public void Scene_ids_are_a_safe_file_name(string? id, bool expected) =>
        Assert.Equal(expected, StudioIds.IsSceneId(id));

    [Theory]
    [InlineData("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.glb", true)]
    [InlineData("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.exe", false)]
    [InlineData("../0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.glb", false)]
    public void Model_keys_are_a_hash_and_a_known_extension(string key, bool expected) =>
        Assert.Equal(expected, StudioIds.IsModelKey(key));
}
