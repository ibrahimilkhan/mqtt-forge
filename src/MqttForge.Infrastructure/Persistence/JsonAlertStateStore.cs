using System.Text.Json;
using Microsoft.Extensions.Logging;
using MqttForge.Application.Alerts;

namespace MqttForge.Infrastructure.Persistence;

/// <summary>
/// The alert state, beside the rules, written at most once a second and read once at startup.
/// </summary>
// Write mechanics are JsonAlertRuleStore's — temp file, then swap — because this file is written
// while the process is running and a container is stopped by having its process killed, which is
// precisely when a half-written document would be left behind.
//
// The reading decision is the opposite of the rule store's, and deliberately so. An unreadable
// rule file is refused because the rules are a record and the next save would delete them. This
// file is not a record; it is a handover from the process that just died, and the only thing a
// corrupt one costs is that handover. Refusing to start over it would mean a truncated write
// during a power cut leaves the console unable to run at all — trading a lost alarm for a dead
// application. So: it is ignored, it is logged at Warning, and the engine starts with what the
// rules say and nothing else. Spec: "Bozuk dosya yoksayılır ve loglanır — bu bir kayıt değil,
// bir devretme."
public sealed class JsonAlertStateStore : IAlertStateStore
{
    // The envelope's only version so far. It exists so that the day the shape changes, the old
    // build meets a number it does not know rather than a document it half understands.
    public const int Version = 1;

    private readonly string _path;
    private readonly ILogger<JsonAlertStateStore> _log;

    // Two arguments, and the logger is not optional: an unwritable mount is reported by logging
    // and by nothing else here — SaveAsync deliberately throws nothing — so a store built without
    // somewhere to say that would fail in perfect silence, once a second, for ever.
    public JsonAlertStateStore(string path, ILogger<JsonAlertStateStore> log)
    {
        _path = path;
        _log = log;
    }

    public async Task<AlertState?> LoadAsync(CancellationToken ct)
    {
        // A first run has no file, and that is not a fault worth a line in anybody's log.
        if (!File.Exists(_path)) return null;

        try
        {
            await using var stream = File.OpenRead(_path);
            var file = await JsonSerializer.DeserializeAsync<StateFile>(stream, AlertRuleJson.File, ct);

            if (file is null || file.Version != Version || file.State is null)
                return Ignored($"{_path} is not a state file this build understands");

            return file.State;
        }
        // JsonException is a truncated or hand-mangled document; NotSupportedException is what STJ
        // raises for a member it cannot build at all — an action type written by a newer build,
        // say; the two IO exceptions are a file that is there but cannot be read.
        catch (Exception ex) when (ex is JsonException or NotSupportedException
                                      or IOException or UnauthorizedAccessException)
        {
            return Ignored($"{_path} could not be read: {ex.Message}");
        }
    }

    public async Task SaveAsync(AlertState state, CancellationToken ct)
    {
        var tempPath = _path + ".tmp";

        try
        {
            var directory = Path.GetDirectoryName(_path);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

            await using (var stream = File.Create(tempPath))
            {
                // AlertRuleJson.File and not a second set of options: an Alert carries the same
                // AlertAction union a rule does, and a webhook action written one way here and
                // read another way there would come back as an alert whose channels had quietly
                // changed. Indented, for the same reason the rule file is — this is a file
                // somebody opens at three in the morning to find out what the console thought
                // was wrong.
                await JsonSerializer.SerializeAsync(
                    stream, new StateFile(Version, state), AlertRuleJson.File, ct);
            }

            File.Move(tempPath, _path, overwrite: true);
        }
        // Nothing is thrown. A rules save that cannot be written has to reach the user, because
        // the user asked for it and would otherwise believe their rule is safe. Nobody asks for
        // this one — it happens once a second, on its own — and turning an unwritable mount into
        // an exception on the engine's own loop would stop the alarming to protect the notes it
        // keeps about the alarming.
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.LogWarning(ex, "Could not write the alert state to {Path}", _path);
        }
    }

    private AlertState? Ignored(string reason)
    {
        _log.LogWarning("Ignoring the alert state: {Reason}", reason);
        return null;
    }

    // The envelope as a type, so the version is a property of the document rather than something
    // the writer has to remember to put in front of the state.
    private sealed record StateFile(int Version, AlertState? State);
}
