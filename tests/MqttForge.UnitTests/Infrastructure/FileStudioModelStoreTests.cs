using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Time.Testing;
using MqttForge.Infrastructure.Persistence;

namespace MqttForge.UnitTests.Infrastructure;

public sealed class FileStudioModelStoreTests : IDisposable
{
    private readonly string _directory =
        Path.Combine(Path.GetTempPath(), $"mqttforge-models-{Guid.NewGuid():N}");

    public void Dispose()
    {
        if (Directory.Exists(_directory)) Directory.Delete(_directory, recursive: true);
    }

    private static MemoryStream Bytes(string text) => new(Encoding.UTF8.GetBytes(text));

    private static string Hash(string text) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));

    [Fact]
    public async Task A_stored_file_is_named_by_its_hash_and_reads_back()
    {
        var store = new FileStudioModelStore(_directory);

        var key = await store.PutAsync(Bytes("solid cube"), ".stl", CancellationToken.None);

        Assert.Equal(Hash("solid cube") + ".stl", key);
        using var read = store.OpenRead(key);
        Assert.NotNull(read);
        Assert.Equal("solid cube", await new StreamReader(read).ReadToEndAsync());
    }

    [Fact]
    public async Task The_same_file_twice_is_stored_once()
    {
        var store = new FileStudioModelStore(_directory);

        var first = await store.PutAsync(Bytes("same"), ".glb", CancellationToken.None);
        var second = await store.PutAsync(Bytes("same"), ".glb", CancellationToken.None);

        Assert.Equal(first, second);
        Assert.Single(Directory.GetFiles(Path.Combine(_directory, "models")));
    }

    [Fact]
    public async Task An_extension_it_does_not_keep_is_refused()
    {
        await Assert.ThrowsAsync<ArgumentException>(
            () => new FileStudioModelStore(_directory).PutAsync(Bytes("x"), ".exe", CancellationToken.None));
    }

    [Fact]
    public void A_key_that_is_not_one_opens_nothing()
    {
        Assert.Null(new FileStudioModelStore(_directory).OpenRead("../../connection-settings.json"));
    }

    [Fact]
    public async Task Unused_files_go_once_they_are_older_than_the_grace_and_kept_ones_stay()
    {
        var time = new FakeTimeProvider(DateTimeOffset.UtcNow);
        var store = new FileStudioModelStore(_directory, time);
        var kept = await store.PutAsync(Bytes("kept"), ".glb", CancellationToken.None);
        var unused = await store.PutAsync(Bytes("unused"), ".glb", CancellationToken.None);

        // A file just uploaded may be about to be named by a scene save still on its way.
        Assert.Equal(0, store.DeleteUnused(new HashSet<string> { kept }, TimeSpan.FromHours(1)));

        time.Advance(TimeSpan.FromHours(2));
        Assert.Equal(1, store.DeleteUnused(new HashSet<string> { kept }, TimeSpan.FromHours(1)));
        using (var stream = store.OpenRead(kept))
        {
            Assert.NotNull(stream);
        }
        Assert.Null(store.OpenRead(unused));
    }
}
