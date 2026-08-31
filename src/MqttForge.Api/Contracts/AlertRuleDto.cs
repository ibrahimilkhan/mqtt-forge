using System.Text.Json.Serialization;
using MqttForge.Application.Alerts;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.Api.Contracts;

/// <summary>
/// A rule on the wire. The same shape as <see cref="AlertRule"/> in every respect but two: the id
/// may be absent, because the server hands one out, and the actions are redacted.
/// </summary>
// Condition and Clear are the domain union itself rather than a parallel DTO union, and that is
// deliberate: the discriminator, the seven cases and their recursion are already a contract shared
// by alert-rules.json and web/src/types/api.ts, and a second declaration of it in this namespace
// would be a third place for it to drift. AlertJsonShapeTests pins the union's bytes; the test
// beside this file pins that a DTO writes those same bytes.
//
// Id is nullable here and not on the record. The spec: "Id taşımayan kurala sunucu bir id verir" —
// the editor opens a window with no id in it, and giving one out here rather than making the
// browser invent it is what keeps ids in one format that a publish topic can carry.
public sealed record AlertRuleDto(
    string? Id,
    string Name,
    bool Enabled,
    string Filter,
    string? Field,
    AlertCondition Condition,
    AlertCondition? Clear,
    int? For,
    int? Cooldown,
    AlertSeverity Severity,
    IReadOnlyList<AlertActionDto> Actions)
{
    /// <summary>The rule as the console is allowed to see it.</summary>
    public static AlertRuleDto Of(AlertRule rule) =>
        new(rule.Id, rule.Name, rule.Enabled, rule.Filter, rule.Field, rule.Condition, rule.Clear,
            rule.For, rule.Cooldown, rule.Severity, [.. rule.Actions.Select(AlertActionDto.Of)]);

    /// <summary>
    /// The rule as it goes to the store, with <paramref name="stored"/> — the rule of the same id
    /// that is on disk right now, or null for one being written for the first time — supplying
    /// every secret the console was never given.
    /// </summary>
    public AlertRule ToRule(AlertRule? stored) =>
        new(Id is { Length: > 0 } id ? id : NewId(),
            Name, Enabled, Filter, Field, Condition, Clear, For, Cooldown, Severity,
            [.. Actions.Select(action => action.ToAction(stored))]);

    // Thirty-two hex characters and nothing else, because this string is a topic level: the
    // default publish topic is "{prefix}{RuleId}/{topic}", so an id carrying a '/' would silently
    // add a level to every alert that rule ever publishes and an id carrying a '+' would be
    // unpublishable. The validator holds a client to the same alphabet.
    private static string NewId() => Guid.NewGuid().ToString("n");
}

/// <summary>
/// The whole rule set, replaced in one PUT — the same one-document trade as the colour rules, and
/// the same cost: two consoles editing at once means the last one to save wins.
/// </summary>
public sealed record AlertRulesDto(IReadOnlyList<AlertRuleDto> Rules)
{
    /// <summary>
    /// The rule set as it goes to the store, matched against <paramref name="stored"/> by id so
    /// that a webhook value the console never saw survives a save of the rule that carries it.
    /// </summary>
    // Matched by id and not by position: the panel reorders nothing today, but a rule set where
    // 'the third row' decided which token belongs to which endpoint would be one drag-and-drop
    // away from posting the boiler's bearer token to the door sensor's server.
    //
    // This is the method AlertController.ReplaceRules calls. It is public and it is the only
    // mapping there is, deliberately: the id handout below and the header merge in AlertActionDto
    // are both pinned by AlertRuleDtoTests, and a controller that mapped for itself would be a
    // second set of answers to the same three questions with no test on it.
    public IReadOnlyList<AlertRule> ToRules(IReadOnlyList<AlertRule> stored)
    {
        var byId = new Dictionary<string, AlertRule>(StringComparer.Ordinal);
        foreach (var rule in stored) byId[rule.Id] = rule;

        return
        [
            .. Rules.Select(dto => dto.ToRule(
                dto.Id is { Length: > 0 } id && byId.TryGetValue(id, out var match) ? match : null))
        ];
    }
}

/// <summary>
/// One channel, flattened. GET carries <see cref="HeaderNames"/> and never a value; PUT carries
/// <see cref="Headers"/>, and a name given with no value keeps the value already on disk.
/// </summary>
// The redaction is SavedConnectionDto's HasPassword with one more thing to say. A password is one
// secret and 'there is one' is the whole message; a webhook carries a set of them, so the message
// is the set of names — enough for the editor to draw the rows it must not fill in.
//
// Flat rather than polymorphic, unlike the condition beside it, and the reason is which side does
// the refusing. An unknown condition type has to be refused by the serialiser, because a rule file
// from a newer build must not be read as something else. An unknown *action* type reaches a
// validator that can say 'this server has never heard of "telegram"' in a message a person can
// act on, and a 400 saying that beats a 400 saying the JSON was malformed.
//
// The optional members are omitted when null so that a screen action is two words on the wire and
// a webhook is the spec's "dışarı: { url, headerNames }" exactly, rather than seven nulls repeated
// on every action of every rule in every frame.
//
// Two rules about the members this DTO is not using:
//   * HeaderNames is out-only. A PUT may carry it — a console that round-trips the GET body will —
//     and it is ignored, because a name with no value is already how 'keep this one' is said.
//   * Headers null and Headers empty are NOT the same request. Null is 'I am not editing the
//     headers', and everything on disk stays; {} is 'there are none', and everything goes. The
//     panel has three writers and two of them (the enabled switch, the delete button) send a rule
//     back without ever having opened the header editor.
public sealed record AlertActionDto(
    string Type,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Url,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyDictionary<string, string>? Headers,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<string>? HeaderNames,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Topic,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? Qos,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? Retain)
{
    // The four words, in one place. They are the [JsonDerivedType] discriminators of AlertAction
    // and a test pins that they still are: the console reads these words to decide whether to
    // make a noise, and the file writes them to decide what to build.
    public const string Screen = "screen";
    public const string Sound = "sound";
    public const string Webhook = "webhook";
    public const string Publish = "publish";

    /// <summary>The word this action is written as, on the wire and in the file alike.</summary>
    public static string NameOf(AlertAction action) => action switch
    {
        ScreenAction => Screen,
        SoundAction => Sound,
        WebhookAction => Webhook,
        PublishAction => Publish,
        _ => throw new ArgumentOutOfRangeException(
            nameof(action), action.GetType().Name, "Unknown alert action.")
    };

    public static AlertActionDto Of(AlertAction action) => action switch
    {
        WebhookAction webhook => new(Webhook, webhook.Url, Headers: null,
            HeaderNames: [.. webhook.Headers.Keys], Topic: null, Qos: null, Retain: null),
        PublishAction publish => new(Publish, Url: null, Headers: null, HeaderNames: null,
            publish.Topic, publish.Qos, publish.Retain),
        _ => new(NameOf(action), Url: null, Headers: null, HeaderNames: null,
            Topic: null, Qos: null, Retain: null)
    };

    /// <summary>
    /// The action as it goes to the store. <paramref name="stored"/> is the rule of the same id on
    /// disk, and it is read for one thing only: the webhook header values the console never had.
    /// </summary>
    // The unrecognised type throws rather than being dropped. The validator refuses it first and
    // this line should be unreachable from an HTTP request — but an action silently missing from a
    // saved rule is a rule that fires and tells nobody, and that failure has to be loud.
    //
    // A publish action with no qos becomes qos 0, not 1. Nothing else would be defensible: the
    // record's own default is 0, alert-rules.json omits the property at 0, and a DTO that read an
    // omitted qos as 1 would silently rewrite every rule the console round-tripped.
    public AlertAction ToAction(AlertRule? stored) => Type switch
    {
        Screen => new ScreenAction(),
        Sound => new SoundAction(),
        Webhook => new WebhookAction(Url ?? string.Empty, MergedHeaders(stored)),
        Publish => new PublishAction(Topic, Qos ?? 0, Retain ?? false),
        _ => throw new ArgumentOutOfRangeException(
            nameof(Type), Type, "Unknown alert action type.")
    };

    private IReadOnlyDictionary<string, string> MergedHeaders(AlertRule? stored)
    {
        var onDisk = StoredHeaders(stored);

        // Not editing the headers at all. Everything stays exactly as it is.
        if (Headers is null) return onDisk;

        var merged = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var (name, value) in Headers)
        {
            // A value the serialiser handed back as null is the same request as an empty one: both
            // are a console saying 'this header, the one you already have'. Nothing else can be
            // meant by them, because the console was never told what the value is.
            if (!string.IsNullOrEmpty(value)) { merged[name] = value; continue; }

            // Kept under the spelling the caller used rather than the one on disk: the value is
            // what was being preserved, and the caller will look for it under its own name next
            // time. Nothing stored means a header the user has added and not filled in yet, and it
            // is kept as an empty value rather than dropped — the name is theirs to have.
            merged[name] = onDisk.TryGetValue(name, out var kept) ? kept : string.Empty;
        }

        return merged;
    }

    // Matched on the URL, and this is the security decision in the file. A header value belongs to
    // an endpoint, not to a row in a list: matched by position, a reordered editor or a changed
    // address would carry yesterday's Authorization header to somewhere it was never issued for —
    // which is precisely the leak the redaction exists to prevent. A URL that changed therefore
    // has nothing to preserve, and the user is asked for the token again.
    //
    // Case-insensitive on the name for the reason every HTTP stack is: 'authorization' and
    // 'Authorization' are one header, and a console that lower-cased what the GET gave it would
    // otherwise silently blank its own token. Built with a loop rather than the dictionary's
    // copying constructor, which throws on a file that holds both spellings.
    private IReadOnlyDictionary<string, string> StoredHeaders(AlertRule? stored)
    {
        var kept = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        if (stored is null || Url is null) return kept;

        var match = stored.Actions
            .OfType<WebhookAction>()
            .FirstOrDefault(webhook => string.Equals(webhook.Url, Url, StringComparison.Ordinal));

        if (match is null) return kept;

        foreach (var (name, value) in match.Headers) kept[name] = value;

        return kept;
    }
}

/// <summary>
/// The answer to GET /api/alert-rules: the rules, and the two things about this server that the
/// console's own sentences depend on.
/// </summary>
// The configuration travels with the rules because the panel is asked to say things only the
// server knows — "webhooks are turned off here", "alerts are published under this prefix" — and
// without a carrier those sentences are unsayable. ExportController.Folder already answers this
// way, with ExportFolderDto(Folder, CanChoose).
//
// Unreadable and SkippedIds are the record half of "Kural dosyası bir kayıttır": a file that
// loaded except for two rules must say so, or the next save deletes them without a word.
public sealed record AlertRulesResponseDto(
    IReadOnlyList<AlertRuleDto> Rules,
    bool AllowWebhooks,
    string TopicPrefix,
    bool Unreadable,
    IReadOnlyList<string> SkippedIds)
{
    public static AlertRulesResponseDto Of(AlertRuleDocument document, AlertEngineOptions options) =>
        new([.. document.Rules.Select(AlertRuleDto.Of)],
            options.AllowWebhooks, options.TopicPrefix, document.Unreadable, document.SkippedIds);
}

/// <summary>
/// The answer to a PUT: what was saved, and what was allowed but is not going to happen.
/// </summary>
// NoContent would have been the obvious answer and it is the wrong one. "Allowed but warned" is
// not something FluentValidation can express — a ValidationFailure drops IsValid and produces a
// 400 — so a naive implementation would have *refused* to save a rule with a webhook on a server
// where webhooks are turned off, rather than saving it and saying it will not fire.
public sealed record AlertRulesSavedDto(
    IReadOnlyList<AlertRuleDto> Rules,
    IReadOnlyList<SaveWarningDto> Warnings);

/// <summary>One rule that saved, and one sentence about why it will not do what it says.</summary>
public sealed record SaveWarningDto(string RuleId, string Reason);
