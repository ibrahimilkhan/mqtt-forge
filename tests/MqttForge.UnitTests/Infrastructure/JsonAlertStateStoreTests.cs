using System.Text.Json;
using Microsoft.Extensions.Logging;
using MqttForge.Application.Alerts;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Persistence;
using Xunit;

namespace MqttForge.UnitTests.Infrastructure;

/// <summary>
/// The one store in this product that treats a file it cannot read as no file at all.
///
/// That is the opposite of JsonAlertRuleStore, and the difference is what the two files are. The
/// rules are a record: calling a broken one "no rules" switches every alarm off in silence and
/// the next save deletes the lot. This one is a handover from the process that just died, and the
/// only thing a broken one costs is that handover — while refusing to start over it would turn a
/// truncated write during a power cut into a console that will not run. Spec: "Bozuk dosya
/// yoksayılır ve loglanır — bu bir kayıt değil, bir devretme."
/// </summary>
public class JsonAlertStateStoreTests : IDisposable
{
    private static readonly DateTimeOffset T0 = new(2026, 8, 30, 9, 0, 0, TimeSpan.Zero);

    private readonly string _path = Path.Combine(Path.GetTempPath(), $"mqttforge-{Guid.NewGuid():N}.json");
    private readonly RecordingLogger _log = new();

    private JsonAlertStateStore Store() => new(_path, _log);

    private static AlertState State() =>
        new(
            [
                new Alert(
                    "1a2b-1", "hot", "Boiler temperature", "plant/boiler/temp", AlertSeverity.Critical,
                    FiredAt: T0, LastSeenAt: T0.AddSeconds(30), ResolvedAt: null, ResolvedBy: null,
                    MutedUntil: T0.AddMinutes(30), Count: 12, Reason: "94.2 > 90", Value: 94.2,
                    Sample: "{\"temp\":94.2}",
                    Actions:
                    [
                        new ScreenAction(),
                        // A webhook with a header, because the action union and its dictionary are
                        // the part of an Alert most likely to come back a different shape.
                        new WebhookAction("http://example.test/hook",
                            new Dictionary<string, string> { ["X-Token"] = "secret" }),
                        new PublishAction(null, 1, true)
                    ])
            ],
            [new MutedPair("hot", "plant/boiler/temp", T0.AddMinutes(30))],
            [new CooldownEntry("hot", "plant/pump/vibration", T0.AddMinutes(1))],
            [new RuleFingerprint("hot", "a3f1")]);

    [Fact]
    public async Task Load_returns_null_when_there_is_no_file()
    {
        Assert.Null(await Store().LoadAsync(CancellationToken.None));
        // A first run has nothing to hand over, and it is not worth a line in anybody's log.
        Assert.Empty(_log.Warnings);
    }

    [Fact]
    public async Task Save_then_Load_returns_the_same_state()
    {
        var state = State();

        await Store().SaveAsync(state, CancellationToken.None);
        var loaded = await Store().LoadAsync(CancellationToken.None);

        Assert.NotNull(loaded);

        // Compared as the text it is meant to be, the way the rule store's round trip is. A
        // record's equality stops at the references its lists carry — AlertState's at three
        // lists, an Alert's at its Actions, a WebhookAction's at its Headers dictionary — so a
        // straight Assert.Equal here would fail on two documents that are the same document.
        Assert.Equal(
            JsonSerializer.Serialize(state, AlertRuleJson.Options),
            JsonSerializer.Serialize(loaded, AlertRuleJson.Options));

        // And the pieces really came back as themselves, rather than surviving the comparison
        // above by being equally wrong on both sides.
        var alert = Assert.Single(loaded.Active);
        Assert.Equal("1a2b-1", alert.Id);
        Assert.Equal(AlertSeverity.Critical, alert.Severity);
        Assert.Equal(T0.AddMinutes(30), alert.MutedUntil);
        var webhook = Assert.IsType<WebhookAction>(alert.Actions[1]);
        Assert.Equal("secret", webhook.Headers["X-Token"]);
        Assert.Equal(new MutedPair("hot", "plant/boiler/temp", T0.AddMinutes(30)), Assert.Single(loaded.Muted));
        Assert.Equal(new CooldownEntry("hot", "plant/pump/vibration", T0.AddMinutes(1)), Assert.Single(loaded.Cooldowns));
        Assert.NotNull(loaded.Fingerprints);
        Assert.Equal(new RuleFingerprint("hot", "a3f1"), Assert.Single(loaded.Fingerprints));
    }

    // The envelope, and the same camelCase contract the rule file writes under: this document
    // carries the AlertAction union, and an action written one way here and read another way
    // there would come back as an alert whose channels had quietly changed.
    [Fact]
    public async Task Save_writes_the_envelope_and_the_discriminators()
    {
        await Store().SaveAsync(State(), CancellationToken.None);

        using var written = JsonDocument.Parse(await File.ReadAllTextAsync(_path));
        Assert.Equal(1, written.RootElement.GetProperty("version").GetInt32());
        var alert = written.RootElement.GetProperty("state").GetProperty("active")[0];
        Assert.Equal("1a2b-1", alert.GetProperty("id").GetString());
        Assert.Equal("critical", alert.GetProperty("severity").GetString());
        Assert.Equal("webhook", alert.GetProperty("actions")[1].GetProperty("type").GetString());
    }

    // Everything a save can be interrupted into: half a document, a whole document that is not
    // one of ours, and a version this build has never heard of.
    [Theory]
    [InlineData("{\"version\":1,\"state\":{\"active\":[")]
    [InlineData("not json at all")]
    [InlineData("[]")]
    [InlineData("{\"version\":2,\"state\":{\"active\":[],\"muted\":[],\"cooldowns\":[]}}")]
    public async Task A_file_this_build_cannot_read_is_ignored_and_logged(string contents)
    {
        await File.WriteAllTextAsync(_path, contents);

        var loaded = await Store().LoadAsync(CancellationToken.None);

        // Null and not an exception, and null and not an empty state: the engine starts from the
        // rules alone, which is exactly what it would have done with no file.
        Assert.Null(loaded);
        Assert.Single(_log.Warnings);
    }

    // The rules file's answer to a broken document is a refusal that blocks the next save. This
    // one deliberately does not have that concept, and a save over a file that could not be read
    // is the ordinary next second of the engine's life.
    [Fact]
    public async Task A_save_over_a_file_that_could_not_be_read_just_writes_it()
    {
        await File.WriteAllTextAsync(_path, "not json at all");
        var store = Store();
        Assert.Null(await store.LoadAsync(CancellationToken.None));

        await store.SaveAsync(State(), CancellationToken.None);

        Assert.NotNull(await store.LoadAsync(CancellationToken.None));
    }

    [Fact]
    public async Task Save_leaves_no_temporary_file_behind()
    {
        await Store().SaveAsync(State(), CancellationToken.None);

        Assert.False(File.Exists(_path + ".tmp"));
    }

    [Fact]
    public async Task Save_writes_into_a_directory_that_does_not_exist_yet()
    {
        var nested = Path.Combine(Path.GetTempPath(), $"mqttforge-{Guid.NewGuid():N}", "alert-state.json");
        var store = new JsonAlertStateStore(nested, _log);

        try
        {
            await store.SaveAsync(State(), CancellationToken.None);

            Assert.NotNull(await store.LoadAsync(CancellationToken.None));
        }
        finally
        {
            var directory = Path.GetDirectoryName(nested);
            if (directory is not null && Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }

    // A mount the container cannot write to, which is what this looks like in practice. The rules
    // store throws here, because a user asked for that save and would otherwise believe their
    // rule was safe. Nobody asks for this one — it happens once a second, on the engine's own
    // loop — and throwing would stop the alarming to protect the notes about the alarming.
    [Fact]
    public async Task A_state_that_cannot_be_written_is_logged_and_not_thrown()
    {
        // A directory where the file should be: File.Create refuses it, on every platform.
        var blocked = Path.Combine(Path.GetTempPath(), $"mqttforge-{Guid.NewGuid():N}");
        Directory.CreateDirectory(blocked);

        try
        {
            await new JsonAlertStateStore(blocked, _log).SaveAsync(State(), CancellationToken.None);

            Assert.Single(_log.Warnings);
        }
        finally
        {
            // The temp file first, and it is not paranoia: only the File.Move onto a directory
            // fails here, so File.Create has already succeeded and '<blocked>.tmp' is sitting in
            // the system temp directory as a real file. It is outside the directory this test
            // made, so deleting the directory does not take it, and a test that leaves litter in
            // /tmp on every run is a test nobody trusts twice.
            if (File.Exists(blocked + ".tmp")) File.Delete(blocked + ".tmp");
            Directory.Delete(blocked, recursive: true);
        }
    }

    public void Dispose()
    {
        if (File.Exists(_path)) File.Delete(_path);
        GC.SuppressFinalize(this);
    }

    // A logger that keeps what it was told, rather than a substitute: ILogger's only method is a
    // generic one taking a state object and a formatter, and an NSubstitute assertion over that
    // signature says less about what happened than this does.
    private sealed class RecordingLogger : ILogger<JsonAlertStateStore>
    {
        public List<string> Warnings { get; } = [];

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
                                Func<TState, Exception?, string> formatter)
        {
            if (logLevel >= LogLevel.Warning) Warnings.Add(formatter(state, exception));
        }
    }
}
