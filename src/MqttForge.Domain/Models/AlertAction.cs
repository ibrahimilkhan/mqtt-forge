using System.Text.Json.Serialization;

namespace MqttForge.Domain.Models;

/// <summary>What happens when a rule fires. Four channels, chosen independently.</summary>
// Same polymorphic shape and the same reasons as AlertCondition: one contract on disk, on the
// wire and in web/src/types/api.ts.
//
// screen and sound are separate rather than one 'notify' with a flag because both halves are
// requests people actually make: a visual alert that must not make a noise in a control room, and
// a noise that must be heard with the panel closed. A single action with a boolean would have
// made 'sound without screen' unsayable.
[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]
[JsonDerivedType(typeof(ScreenAction), "screen")]
[JsonDerivedType(typeof(SoundAction), "sound")]
[JsonDerivedType(typeof(WebhookAction), "webhook")]
[JsonDerivedType(typeof(PublishAction), "publish")]
public abstract record AlertAction;

/// <summary>A notice in the corner of the console, and a row in the panel.</summary>
public sealed record ScreenAction : AlertAction;

/// <summary>A tone in the browser, pitched by severity. Never a sound from the server.</summary>
public sealed record SoundAction : AlertAction;

/// <summary>
/// A POST to an address the user gave, with headers the user gave.
/// </summary>
// Headers are held here in plain text because that is what they are on disk, and pretending
// otherwise in the model would only hide it from whoever reads this file. The DTO going out is
// the one that drops the values and sends header names alone, the way SavedConnectionDto sends
// HasPassword; SECURITY.md says so in as many words.
public sealed record WebhookAction(string Url, IReadOnlyDictionary<string, string> Headers) : AlertAction;

/// <summary>
/// The alert, published back to the broker. A null <paramref name="Topic"/> means the default,
/// <c>{prefix}{RuleId}/{topic}</c>.
/// </summary>
// Null rather than the expanded default being stored: the prefix is a server setting, and a rule
// file that had baked yesterday's prefix into every publish action would quietly keep writing to
// the old place after the setting changed.
public sealed record PublishAction(string? Topic, int Qos, bool Retain) : AlertAction;
