using System.Text.RegularExpressions;
using FluentValidation;
using MqttForge.Api.Contracts;
using MqttForge.Application.Alerts;
using MqttForge.Application.Alerts.Conditions;
using MqttForge.Domain;
using MqttForge.Domain.Models;

namespace MqttForge.Api.Validation;

/// <summary>
/// Everything a rule set has to be before it is written down. Two kinds of refusal live here: a
/// rule that cannot work, and a rule that works and does damage.
/// </summary>
// Longer than every other validator in this folder put together, and the reason is the second
// kind. A colour rule that is wrong colours a row wrongly. An alert rule that is wrong subscribes
// the engine to its own alarms, or retains twenty boilers' alarms on top of one another, or
// publishes back into the very topics it is watching — all of it valid MQTT, all of it saved
// without complaint by anything that only checks shapes.
//
// It takes AlertEngineOptions because two of those rules are about the server's own configuration:
// where the engine publishes, and therefore where nobody else may. FluentValidation resolves
// validators from the container — AddValidatorsFromAssemblyContaining already scans this assembly
// — and AlertEngineOptions is a registered singleton, so this needs no registration of its own.
//
// `partial` because of the [GeneratedRegex] property below, exactly as ColourRulesDtoValidator is:
// the source generator writes the other half of WellFormedId into a second declaration of this
// class, and without the modifier the build stops at CS0260 before a single test runs.
//
// The statistical conditions the spec ranges (`window` 20..2000, `k` 0.5–5 for tukey and 1–10 for
// sigma) are NOT checked here, because outlier, distributionShift, shapeChange and pulse are not
// in AlertCondition yet — they arrive in plan 4, together with the rules for them. Until they do,
// a body naming one is refused by the serialiser before this class is constructed, and
// AlertRuleDtoValidatorTests pins that.
public sealed partial class AlertRulesDtoValidator : AbstractValidator<AlertRulesDto>
{
    public const int MaxRules = 100;
    public const int MaxNameLength = 80;

    /// <summary>Spec, "### Sayılar": "Regex uzunluğu / gördüğü metin | 250 karakter / 4 kB".</summary>
    public const int MaxPatternLength = 250;

    public const int MaxHeaders = 10;
    public const int MaxHeaderNameLength = 64;
    public const int MaxHeaderValueLength = 1024;
    public const int MaxIdLength = 64;

    /// <summary>What a rule id may hold, because it is a level of a topic the engine publishes to.</summary>
    [GeneratedRegex("^[A-Za-z0-9_-]{1,64}$")]
    private static partial Regex WellFormedId { get; }

    private readonly string _prefix;

    public AlertRulesDtoValidator(AlertEngineOptions options)
    {
        _prefix = options.TopicPrefix;

        RuleFor(x => x.Rules)
            .NotNull()
            .Must(rules => rules.Count <= MaxRules)
            .WithMessage($"No more than {MaxRules} alert rules.");

        // Two rules under one id are one rule to everything downstream: the engine keys its state
        // by (rule, topic), so the second would inherit the first's cooldowns and mutes and neither
        // would behave as written.
        RuleFor(x => x.Rules)
            .Must(rules => rules
                .Where(rule => !string.IsNullOrEmpty(rule.Id))
                .Select(rule => rule.Id)
                .Distinct(StringComparer.Ordinal)
                .Count() == rules.Count(rule => !string.IsNullOrEmpty(rule.Id)))
            .When(x => x.Rules is not null)
            .WithMessage("Two alert rules cannot share an id.");

        RuleForEach(x => x.Rules).ChildRules(rule =>
        {
            // Only when it was given: a rule the editor has never saved carries no id, and the
            // server hands one out in AlertRuleDto.ToRule.
            rule.RuleFor(x => x.Id)
                .Must(id => id is not null && WellFormedId.IsMatch(id))
                .When(x => !string.IsNullOrEmpty(x.Id))
                .WithMessage("A rule id may hold only letters, digits, '-' and '_', and at most " +
                             $"{MaxIdLength} of them: it is a level of the topic the rule publishes to.");

            rule.RuleFor(x => x.Name).NotEmpty().MaximumLength(MaxNameLength);

            rule.RuleFor(x => x.Filter)
                .Must(TopicFilter.IsValid)
                .WithMessage("'{PropertyValue}' is not a valid topic filter.");

            // The engine drops every message arriving from under its own prefix, so a rule
            // filtering over that tree is not a loop — it is a subscription that costs bandwidth,
            // matches messages and can never once fire. Refusing it is the only way the person who
            // wrote it ever finds out.
            rule.RuleFor(x => x.Filter)
                .Must(filter => !AlertTopicPrefix.Covers(filter, _prefix))
                .When(x => TopicFilter.IsValid(x.Filter))
                .WithMessage($"A rule cannot watch '{_prefix}': that is where this server publishes " +
                             "its own alerts, and the engine ignores everything under it.");

            rule.RuleFor(x => x.Condition).NotNull();

            // One walk of the tree rather than a chain of rules over it, because the union is
            // recursive and the message has to name the offending child — 'the pattern
            // "(unclosed" does not compile' is actionable and 'condition is invalid' is not.
            rule.RuleFor(x => x.Condition).Custom((condition, context) =>
            {
                if (condition is null) return;
                if (Fault(condition) is { } why) context.AddFailure(why);
            });

            // 'nothing has arrived for 300 seconds, for 30 seconds' has no meaning the engine could
            // implement, and the two numbers read as one interval to everybody who sees them. The
            // whole tree and not just the root: a silence inside an `any` is still a silence.
            rule.RuleFor(x => x.For)
                .Must((x, _) => !HoldsSilence(x.Condition))
                .When(x => x.For is not null && x.Condition is not null)
                .WithMessage("'for' cannot be given with a silence condition: a silence is already " +
                             "a duration.");

            rule.RuleFor(x => x.For).GreaterThanOrEqualTo(0).When(x => x.For is not null);
            rule.RuleFor(x => x.Cooldown).GreaterThanOrEqualTo(0).When(x => x.Cooldown is not null);

            // The enum converter refuses an unknown word, but a number binds to whatever it says,
            // and a severity of 7 is a row the panel cannot colour and a tone it cannot pick.
            rule.RuleFor(x => x.Severity).IsInEnum();

            rule.RuleFor(x => x.Actions).NotNull();

            // Also one walk, and for a second reason: two of these rules are about the rule as a
            // whole rather than about the action — a retained publish is refused for what the
            // rule's *filter* says — and FluentValidation's RuleForEach hands a child validator
            // the action alone, with no way back up to the rule that carries it. Inside a
            // ChildRules block, context.InstanceToValidate is the child DTO, which is the rule.
            rule.RuleFor(x => x.Actions).Custom((actions, context) =>
            {
                if (actions is null) return;

                foreach (var failure in Faults(context.InstanceToValidate, actions))
                    context.AddFailure(failure);
            });
        });
    }

    /// <summary>Why this condition tree cannot be saved, or null if it can.</summary>
    private static string? Fault(AlertCondition condition)
    {
        switch (condition)
        {
            case PatternCondition pattern:
                if (pattern.Regex.Length > MaxPatternLength)
                    return $"A pattern may be at most {MaxPatternLength} characters.";

                // Compiled the way CompiledPatterns compiles it, and that is not a detail: it tries
                // NonBacktracking first and falls back to the timed engine for the patterns
                // NonBacktracking refuses. A validator that only tried the linear engine would
                // refuse legal regexes the engine would have run perfectly well — and one that only
                // tried the ordinary engine would accept patterns the engine then could not build.
                //
                // Compiling here is also the only moment the user can be told. JsonAlertRuleStore
                // compiles again on load, because a rule file edited by hand never came past this.
                try
                {
                    CompiledPatterns.Compile(pattern.Regex);
                }
                catch (ArgumentException)
                {
                    // RegexParseException derives from ArgumentException, and so does everything
                    // else a malformed pattern produces. Caught as the base because which of them
                    // arrives is a .NET version's business, and a 500 from a typed catch that
                    // missed one is the wrong answer to a bad regex.
                    return $"The pattern '{pattern.Regex}' is not a valid regular expression.";
                }

                return null;

            // A silence of zero is not a silence rule, it is a rule that fires on every tick for
            // every topic it has ever seen.
            case SilenceCondition silence when silence.After <= 0:
                return "A silence condition has to wait at least a second.";

            case AllCondition all:
                return all.Of.Select(Fault).FirstOrDefault(fault => fault is not null);

            case AnyCondition any:
                return any.Of.Select(Fault).FirstOrDefault(fault => fault is not null);

            default:
                return null;
        }
    }

    // Depth is not policed here on purpose: System.Text.Json refuses anything deeper than 64
    // levels while binding, so a hand-written 'all' chain deep enough to overflow this recursion
    // cannot reach the validator in the first place.
    private static bool HoldsSilence(AlertCondition? condition) => condition switch
    {
        SilenceCondition => true,
        AllCondition all => all.Of.Any(HoldsSilence),
        AnyCondition any => any.Of.Any(HoldsSilence),
        _ => false
    };

    /// <summary>Everything wrong with the channels this rule asks for.</summary>
    private IEnumerable<string> Faults(AlertRuleDto rule, IReadOnlyList<AlertActionDto> actions)
    {
        foreach (var action in actions)
        {
            switch (action.Type)
            {
                case AlertActionDto.Screen:
                case AlertActionDto.Sound:
                    break;

                case AlertActionDto.Webhook:
                    foreach (var fault in WebhookFaults(action)) yield return fault;
                    break;

                case AlertActionDto.Publish:
                    foreach (var fault in PublishFaults(rule, action)) yield return fault;
                    break;

                default:
                    // Named rather than described, because the console's own vocabulary is the
                    // answer to it: this server knows four channels and it says which four.
                    yield return $"'{action.Type}' is not an alert channel. This server knows " +
                                 $"'{AlertActionDto.Screen}', '{AlertActionDto.Sound}', " +
                                 $"'{AlertActionDto.Webhook}' and '{AlertActionDto.Publish}'.";
                    break;
            }
        }
    }

    private static IEnumerable<string> WebhookFaults(AlertActionDto action)
    {
        // Absolute and http(s) only. A relative URL has no host to post to, and a scheme this
        // server does not speak is a rule that fails on its first alarm rather than on its save.
        if (!Uri.TryCreate(action.Url, UriKind.Absolute, out var url)
            || (url.Scheme != Uri.UriSchemeHttp && url.Scheme != Uri.UriSchemeHttps))
        {
            yield return "A webhook url has to be an absolute http:// or https:// address.";
            yield break;
        }

        // Credentials in the URL are sent to the endpoint by every redirect and written into every
        // log on the way. The header map beside it is where this design put secrets on purpose.
        if (!string.IsNullOrEmpty(url.UserInfo))
            yield return "A webhook url must not carry a username or password. Use a header.";

        if (action.Headers is not { } headers) yield break;

        if (headers.Count > MaxHeaders)
            yield return $"A webhook may carry at most {MaxHeaders} headers.";

        foreach (var (name, value) in headers)
        {
            if (string.IsNullOrEmpty(name) || name.Length > MaxHeaderNameLength)
                yield return $"A header name has to be 1 to {MaxHeaderNameLength} characters.";

            // Not IsNullOrEmpty: an empty value is the redaction's own sentence — 'this header, the
            // one you already have' — and a rule refused for it could never be saved twice.
            if (value is not null && value.Length > MaxHeaderValueLength)
                yield return $"A header value may be at most {MaxHeaderValueLength} characters.";

            // A CR or LF in a header is a request-splitting attempt or a copy-paste accident and
            // there is no telling which, so neither goes out over a socket this server opened.
            if (Controls(name) || Controls(value))
                yield return "A header cannot hold a control character.";
        }
    }

    private IEnumerable<string> PublishFaults(AlertRuleDto rule, AlertActionDto action)
    {
        if (action.Qos is < 0 or > 2)
            yield return "A publish action's qos has to be 0, 1 or 2.";

        // Null is the default topic, "{prefix}{RuleId}/{topic}", which is inside the prefix and
        // carries the placeholder by construction — so saying nothing is both the easy answer and
        // the safe one, and there is nothing left to check.
        if (action.Topic is not { } topic)
        {
            yield break;
        }

        if (topic.Length == 0 || topic.Contains('\0'))
        {
            yield return "A publish topic cannot be empty.";
            yield break;
        }

        // A publication is to one topic. '+' and '#' are subscription syntax and a broker will
        // refuse them on a PUBLISH, which would surface as an alarm that silently never arrives.
        if (TopicFilterMatch.HasWildcard(topic))
            yield return "A publish topic cannot carry a wildcard.";

        if (!AlertTopicPrefix.Inside(topic, _prefix))
            yield return $"A publish topic has to stay under '{_prefix}'. " +
                         "Anything else writes the engine's own alerts back into the plant.";

        // The subtlest rule in the file. One rule over 'plant/+/temp' watches twenty boilers; a
        // retained publish to one fixed topic means the twentieth alarm overwrites the nineteenth,
        // and the zero-byte retained message that clears one of them erases the record of all of
        // them. Retained state needs somewhere per topic to live, and {topic} is that somewhere.
        if (action.Retain is true
            && TopicFilterMatch.HasWildcard(rule.Filter)
            && !topic.Contains(AlertTopicPrefix.Placeholder, StringComparison.Ordinal))
        {
            yield return $"A retained publish from a wildcard filter has to carry " +
                         $"'{AlertTopicPrefix.Placeholder}' in its topic, or every topic the rule " +
                         "watches overwrites the last one's retained alarm.";
        }
    }

    private static bool Controls(string? text) => text is not null && text.Any(char.IsControl);
}


/// <summary>
/// Silencing one (rule, topic) pair.
/// </summary>
// The engine clamps as well, and deliberately: this validator only sees what a panel sends, and
// AlertEngineCore also restores mutes from a state file that has been through a text editor.
public sealed class MuteRequestDtoValidator : AbstractValidator<MuteRequestDto>
{
    public MuteRequestDtoValidator()
    {
        RuleFor(x => x.RuleId).NotEmpty();

        // A concrete topic, the one an alarm is actually ringing on. A filter here would look like
        // it silenced twenty boilers and would silence none of them, because nothing downstream
        // ever matches a mute against anything — the pair is looked up, not matched.
        RuleFor(x => x.Topic)
            .NotEmpty()
            .Must(topic => topic is not null
                           && !topic.Contains('\0')
                           && !TopicFilterMatch.HasWildcard(topic))
            .WithMessage("A mute names one topic, not a filter.");

        // Zero is the undo — the panel's "Geri al" button sends exactly this. Past a day, muting is
        // disabling the rule without ever using the word, so the editor stops there and says so.
        RuleFor(x => x.Minutes).InclusiveBetween(0, AlertEngineCore.MaxMuteMinutes);
    }
}
