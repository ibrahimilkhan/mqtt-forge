using MqttForge.Application.Alerts;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Services;

/// <summary>
/// The alert rules, read and replaced whole — and, unlike the colour rules, never written over a
/// document this build could not read.
/// </summary>
// ColourRuleService is three lines and this one is not, and the difference is entirely the spec's
// "Kural dosyası bir kayıttır". Colours are a preference: losing them costs an afternoon of
// picking them again. Rules are a record of what somebody decided had to be watched, and the two
// dangerous things about a broken rules file — that a running engine silently alarms on nothing,
// and that the next save makes the loss permanent — are both prevented here rather than upstream.
//
// The other half of this class is the push. A save writes the file and then puts the new rule set
// on the engine's channel; the engine never reads the file again after startup. ColourRuleService's
// "nothing is cached" is right for a panel that reads a hundred short records when a console
// loads, and wrong for something a message path asks about fifty times a second.
public sealed class AlertRuleService
{
    private readonly IAlertRuleStore _store;
    private readonly AlertEngine _engine;

    public AlertRuleService(IAlertRuleStore store, AlertEngine engine)
    {
        _store = store;
        _engine = engine;
    }

    /// <summary>The document as the file gave it, unreadable flag and skipped ids included.</summary>
    // Not a list of rules. The panel's red row and its "3 rules could not be read" line are drawn
    // from the other two fields, and a caller handed only the rules could not tell an empty file
    // from a broken one — which is the single distinction this whole design turns on.
    public Task<AlertRuleDocument> GetAsync(CancellationToken ct) => _store.LoadAsync(ct);

    /// <summary>
    /// Writes the whole rule set, then hands it to the engine. Refuses when the file on disk holds
    /// something this build could not read and <paramref name="discardUnreadable"/> is false.
    /// </summary>
    public async Task ReplaceAsync(IReadOnlyList<AlertRule> rules, bool discardUnreadable,
                                   CancellationToken ct)
    {
        // Read before write, every time, and not from a cached document either. The file is on a
        // volume somebody else can touch: the panel may have loaded an hour ago, and what matters
        // is what is on the disk at the moment of the save rather than what was there when the
        // editor was opened.
        var current = await _store.LoadAsync(ct);

        if (!discardUnreadable && Refusal(current) is { } why)
            throw new AlertRulesUnreadableException(why);

        // Throws AlertRulesNotSavedException, and it travels out of here untouched. That type
        // exists so the reader is told "could not save the alert rules" rather than a sentence
        // about a colour panel they never opened, and wrapping it again here would undo that.
        await _store.SaveAsync(rules, ct);

        // Only after the write. An engine running a rule set that is nowhere on disk would come
        // back from the next restart as a different product, and the file is the record.
        //
        // Posted, never applied: this is a Kestrel thread, and the core is single-threaded by
        // construction with not a lock in it. The queue is where the two worlds meet.
        _engine.Post(new RuleSetChangedCommand(rules));
    }

    /// <summary>Why this save must not go through, or null if it may.</summary>
    private static string? Refusal(AlertRuleDocument current)
    {
        // Named rules first, and the order here is load-bearing. JsonAlertRuleStore.LoadAsync ends
        // with `new AlertRuleDocument(rules, skipped.Count > 0, skipped)`, so it sets Unreadable
        // whenever it skipped anything at all — a file that loaded except for one unknown condition
        // arrives with BOTH flags up. Asking Unreadable first would mean the "could not be read"
        // sentence is the only one this service ever produces in the field, and the specific one,
        // the one that names the rule the user is about to lose, would be dead code.
        //
        // The same argument as the sentence below it, one rule at a time: a rule written by a newer
        // build, or by hand, that this reader could not bind. It is not in what the panel is
        // sending back, because the panel never received it, so writing this list deletes it.
        if (current.SkippedIds.Count > 0)
            return $"The alert rules file holds {current.SkippedIds.Count} rule(s) this build " +
                   $"cannot read ({string.Join(", ", current.SkippedIds)}). They are not in what " +
                   "you are saving, so saving would delete them. Save again asking for them to " +
                   "be discarded if that is what you mean.";

        // Nothing could be read, so nothing can be compared: whatever is in that file, this save
        // is not an edit of it. Overwriting is how a corrupt-file incident becomes a lost rule set.
        if (current.Unreadable)
            return "The alert rules file could not be read, so saving over it would throw away " +
                   "whatever it holds. Repair the file, or save again asking for it to be discarded.";

        // An empty list is not a refusal. Deleting the last rule is a thing people do, and the
        // empty file that results reads back as an empty rule set rather than as a fault.
        return null;
    }
}
