using System.Text.Json;
using MqttForge.Application.Alerts;
using MqttForge.Application.Alerts.Conditions;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;

namespace MqttForge.Infrastructure.Persistence;

// Write mechanics are JsonColourRuleStore's — temp file, then swap, so an interrupted write
// cannot leave half a document behind. The reading decision is the opposite one, and on purpose:
// colours are a preference and a file nobody can read is worth less than a clean start, while
// alert rules are a record. Calling a broken file "no rules" here would turn every alarm off
// without saying so, and the next save would delete the lot.
public sealed class JsonAlertRuleStore : IAlertRuleStore
{
    // The envelope's only version so far. It exists so that the day the shape changes, the old
    // build meets a number it does not know rather than a document it half understands.
    public const int Version = 1;

    private readonly string _path;

    public JsonAlertRuleStore(string path) => _path = path;

    public async Task<AlertRuleDocument> LoadAsync(CancellationToken ct)
    {
        // No file is not a fault. A first run has nothing to protect, and calling this
        // unreadable would lock every new install out of saving its first rule.
        if (!File.Exists(_path)) return new AlertRuleDocument([], Unreadable: false, []);

        JsonDocument parsed;
        try
        {
            await using var stream = File.OpenRead(_path);
            parsed = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            return Unreadable();
        }

        // Deserialised a rule at a time rather than in one go, because one rule the reader
        // cannot bind must not cost the ninety-nine it can. STJ gives up on the whole document
        // at the first unknown "type", and that is the case this file is most likely to meet:
        // a rule written by a newer build, or by a hand.
        using (parsed)
        {
            var root = parsed.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return Unreadable();

            if (!root.TryGetProperty("version", out var version) ||
                version.ValueKind != JsonValueKind.Number ||
                !version.TryGetInt32(out var number) ||
                number != Version)
                return Unreadable();

            // A missing array is a truncated write, not an empty rule set: an empty one is
            // written as [] and comes back as one.
            if (!root.TryGetProperty("rules", out var array) || array.ValueKind != JsonValueKind.Array)
                return Unreadable();

            var rules = new List<AlertRule>();
            var skipped = new List<string>();
            var position = 0;

            foreach (var element in array.EnumerateArray())
            {
                position++;
                try
                {
                    // AlertRuleJson.Options, not a set of options built here. The shape of this
                    // file is a contract with the PUT body and with web/src/types/api.ts, and a
                    // second configuration anywhere is a way for the three to drift apart while
                    // every test stays green. Reading takes the unindented set: indenting is a
                    // property of what gets written, not of what can be understood.
                    var rule = element.Deserialize<AlertRule>(AlertRuleJson.Options);
                    if (rule is null)
                    {
                        skipped.Add(NameOf(element, position));
                        continue;
                    }

                    CompilePatterns(rule.Condition);
                    if (rule.Clear is not null) CompilePatterns(rule.Clear);
                    rules.Add(rule);
                }
                // JsonException covers an unknown discriminator and a member of the wrong shape;
                // NotSupportedException is what STJ raises for a member it cannot build at all;
                // ArgumentException is what a pattern that will not compile arrives as.
                catch (Exception ex) when (ex is JsonException or NotSupportedException or ArgumentException)
                {
                    skipped.Add(NameOf(element, position));
                }
            }

            // Rules to run AND unreadable, together, and that pairing is the whole point: the
            // engine gets everything it can judge, and a save is refused because writing this
            // list back would quietly delete the rules nobody here understood.
            return new AlertRuleDocument(rules, skipped.Count > 0, skipped);
        }
    }

    public async Task SaveAsync(IReadOnlyList<AlertRule> rules, CancellationToken ct)
    {
        // Whether saving is allowed over an unreadable file is not settled here. The store
        // writes what it is handed; refusing is a decision about the user's intent, and it
        // belongs where the request and its ?discardUnreadable=true arrive.
        var tempPath = _path + ".tmp";

        try
        {
            var directory = Path.GetDirectoryName(_path);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

            await using (var stream = File.Create(tempPath))
            {
                // AlertRuleJson.File is AlertRuleJson.Options with one difference — it is
                // indented — because this is a file someone opens in an editor at three in the
                // morning. Everything else about the shape is the wire's, deliberately: enums
                // are written as names for the reason the connection settings give, in that
                // "critical" answers a question a 2 only raises.
                await JsonSerializer.SerializeAsync(
                    stream, new RuleFile(Version, rules), AlertRuleJson.File, ct);
            }

            File.Move(tempPath, _path, overwrite: true);
        }
        // RulesNotSavedException is not reused: the user would be told their colour rules could
        // not be saved. In practice this is a mount the container cannot write to.
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new AlertRulesNotSavedException(
                $"Could not write the alert rules to {_path}: {ex.Message}", ex);
        }
    }

    private static AlertRuleDocument Unreadable() => new([], Unreadable: true, []);

    // A rule that did not bind still has to be nameable in the panel's warning line. The id is
    // what everything else addresses a rule by; a rule that arrived without one is named by
    // where it sits in the file, which is the only handle left.
    private static string NameOf(JsonElement element, int position) =>
        element.ValueKind == JsonValueKind.Object &&
        element.TryGetProperty("id", out var id) &&
        id.ValueKind == JsonValueKind.String &&
        !string.IsNullOrWhiteSpace(id.GetString())
            ? id.GetString()!
            : $"rule {position}";

    // Compiled here as well as in the validator, because a rule that arrived by someone editing
    // the file never met the validator. A pattern that will not build has to fail on this side
    // of the message path — the far side is the pump, and the pump is not the place to find out.
    // The recursion is bounded by the reader: JsonDocument refuses to parse past sixty-four
    // levels, so a tree that reached this method is one the stack can walk.
    private static void CompilePatterns(AlertCondition condition)
    {
        switch (condition)
        {
            case PatternCondition pattern:
                CompiledPatterns.Compile(pattern.Regex);
                break;
            case AllCondition all:
                foreach (var inner in all.Of) CompilePatterns(inner);
                break;
            case AnyCondition any:
                foreach (var inner in any.Of) CompilePatterns(inner);
                break;
        }
    }

    // The envelope as a type, so the version is a property of the document rather than something
    // the writer has to remember to put in front of the array.
    private sealed record RuleFile(int Version, IReadOnlyList<AlertRule> Rules);
}
