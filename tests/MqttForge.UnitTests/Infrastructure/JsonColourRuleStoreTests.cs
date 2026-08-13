using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Persistence;
using Xunit;

namespace MqttForge.UnitTests.Infrastructure;

public class JsonColourRuleStoreTests : IDisposable
{
    private readonly string _path = Path.Combine(Path.GetTempPath(), $"mqttforge-{Guid.NewGuid():N}.json");

    [Fact]
    public async Task Load_returns_empty_when_file_missing()
    {
        var store = new JsonColourRuleStore(_path);

        Assert.Empty(await store.LoadAsync(CancellationToken.None));
    }

    [Fact]
    public async Task Save_then_Load_returns_same_rules()
    {
        var store = new JsonColourRuleStore(_path);
        TopicColourRule[] rules = [new("sensors/+/temp", "#b45309"), new("alerts/#", "#ab3520")];

        await store.SaveAsync(rules, CancellationToken.None);

        Assert.Equal(rules, await store.LoadAsync(CancellationToken.None));
    }

    // Rules are a preference, not a record: a file nobody can read is worth less than a clean start.
    [Fact]
    public async Task Load_returns_empty_when_file_is_corrupt()
    {
        await File.WriteAllTextAsync(_path, "{ not json");
        var store = new JsonColourRuleStore(_path);

        Assert.Empty(await store.LoadAsync(CancellationToken.None));
    }

    // 'null' parses as JSON but carries no list; it must not reach the caller as one.
    [Fact]
    public async Task Load_returns_empty_when_file_holds_null()
    {
        await File.WriteAllTextAsync(_path, "null");
        var store = new JsonColourRuleStore(_path);

        Assert.Empty(await store.LoadAsync(CancellationToken.None));
    }

    [Fact]
    public async Task Save_replaces_what_was_there()
    {
        var store = new JsonColourRuleStore(_path);
        await store.SaveAsync([new TopicColourRule("a/#", "#1e40af")], CancellationToken.None);

        await store.SaveAsync([new TopicColourRule("b/#", "#0d7a63")], CancellationToken.None);

        var loaded = await store.LoadAsync(CancellationToken.None);
        Assert.Equal([new TopicColourRule("b/#", "#0d7a63")], loaded);
    }

    [Fact]
    public async Task Save_creates_the_directory()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"mqttforge-{Guid.NewGuid():N}");
        var nested = Path.Combine(directory, "colour-rules.json");
        var store = new JsonColourRuleStore(nested);

        try
        {
            await store.SaveAsync([new TopicColourRule("a/#", "#1e40af")], CancellationToken.None);

            Assert.True(File.Exists(nested));
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task Save_leaves_no_temp_file_behind()
    {
        var store = new JsonColourRuleStore(_path);

        await store.SaveAsync([new TopicColourRule("a/#", "#1e40af")], CancellationToken.None);

        Assert.False(File.Exists(_path + ".tmp"));
    }

    public void Dispose()
    {
        if (File.Exists(_path)) File.Delete(_path);
    }
}
