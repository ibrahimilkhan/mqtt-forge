using MqttForge.Infrastructure.Persistence;
using Xunit;

namespace MqttForge.UnitTests.Infrastructure;

public class JsonReconnectOptionStoreTests : IDisposable
{
    private readonly string _path =
        Path.Combine(Path.GetTempPath(), $"mqttforge-reconnect-{Guid.NewGuid():N}.json");

    private JsonReconnectOptionStore Store() => new(_path);

    // Null rather than a bool, so that "nobody has said" and "somebody said no" are different
    // answers. Collapsed into false they would be the same, and the shipped default is true.
    [Fact]
    public async Task Nothing_saved_is_not_the_same_as_saved_false()
    {
        Assert.Null(await Store().LoadAsync(CancellationToken.None));

        await Store().SaveAsync(false, CancellationToken.None);

        Assert.False(await Store().LoadAsync(CancellationToken.None));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task What_was_saved_is_what_comes_back(bool enabled)
    {
        await Store().SaveAsync(enabled, CancellationToken.None);

        Assert.Equal(enabled, await Store().LoadAsync(CancellationToken.None));
    }

    [Fact]
    public async Task The_later_answer_wins()
    {
        await Store().SaveAsync(false, CancellationToken.None);
        await Store().SaveAsync(true, CancellationToken.None);

        Assert.True(await Store().LoadAsync(CancellationToken.None));
    }

    // A preference, not a rule set. The worst a lost one can do is supervise a link somebody had
    // turned supervision off for, which is visible on the panel and one click from being turned
    // off again; refusing to start over it would be the more expensive mistake.
    [Fact]
    public async Task An_unreadable_file_reads_as_nothing_saved()
    {
        await File.WriteAllTextAsync(_path, "{ not json at all");

        Assert.Null(await Store().LoadAsync(CancellationToken.None));
    }

    [Fact]
    public async Task A_file_with_the_wrong_shape_in_it_reads_as_nothing_saved()
    {
        await File.WriteAllTextAsync(_path, "null");

        Assert.Null(await Store().LoadAsync(CancellationToken.None));
    }

    // The file is a thing people open. `{ "enabled": false }` answers the question it was opened
    // with, where a bare `false` only raises it.
    [Fact]
    public async Task The_file_says_what_it_is_about()
    {
        await Store().SaveAsync(false, CancellationToken.None);

        Assert.Contains("\"Enabled\": false", await File.ReadAllTextAsync(_path));
    }

    [Fact]
    public async Task An_interrupted_write_leaves_no_temp_file_behind()
    {
        await Store().SaveAsync(true, CancellationToken.None);

        Assert.False(File.Exists(_path + ".tmp"));
    }

    [Fact]
    public async Task A_directory_that_does_not_exist_yet_is_made()
    {
        var nested = Path.Combine(
            Path.GetTempPath(), $"mqttforge-{Guid.NewGuid():N}", "deeper", "reconnect.json");
        var store = new JsonReconnectOptionStore(nested);

        await store.SaveAsync(false, CancellationToken.None);

        Assert.False(await store.LoadAsync(CancellationToken.None));
        Directory.Delete(Path.GetDirectoryName(Path.GetDirectoryName(nested))!, recursive: true);
    }

    public void Dispose()
    {
        if (File.Exists(_path)) File.Delete(_path);
    }
}
