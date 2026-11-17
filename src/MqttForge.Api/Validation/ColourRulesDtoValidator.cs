using System.Text.RegularExpressions;
using FluentValidation;
using MqttForge.Api.Contracts;

namespace MqttForge.Api.Validation;

public sealed partial class ColourRulesDtoValidator : AbstractValidator<ColourRulesDto>
{
    /// <summary>What a browser can be handed to put in a style attribute, and nothing else.</summary>
    [GeneratedRegex("^#[0-9a-fA-F]{6}$")]
    private static partial Regex HexTriple { get; }

    public const int MaxRules = 100;

    public ColourRulesDtoValidator()
    {
        RuleFor(x => x.Rules)
            .NotNull()
            .Must(rules => rules.Count <= MaxRules)
            .WithMessage($"No more than {MaxRules} colour rules.");

        // Two rules on one filter for one broker cannot both win, and quietly dropping one leaves
        // the user unable to explain why the rule they typed does nothing. For two brokers they can
        // — only one of the two is ever up — and one for every broker beside one for a broker is
        // the general colour and its exception: the broker's own wins while that broker is up.
        RuleFor(x => x.Rules)
            .Must(rules => rules.Select(rule => (rule.Filter, Owner(rule))).Distinct().Count() == rules.Count)
            .When(x => x.Rules is not null)
            .WithMessage("Each topic filter can carry only one colour for each broker.");

        RuleForEach(x => x.Rules).ChildRules(rule =>
        {
            rule.RuleFor(x => x.Filter)
                .Cascade(CascadeMode.Stop)
                .Must(TopicFilter.FitsMqtt)
                .WithMessage(TopicFilter.TooLong)
                .Must(TopicFilter.IsValid)
                .WithMessage("'{PropertyValue}' is not a valid topic filter.");

            rule.RuleFor(x => x.Colour)
                .Must(colour => colour is not null && HexTriple.IsMatch(colour))
                .WithMessage("'{PropertyValue}' is not a #rrggbb colour.");

            // The second colour is allowed to be absent — that is a rule which paints the topic
            // and leaves the payload alone — but a value that is present is held to exactly the
            // same standard, because it reaches the same style attribute.
            rule.RuleFor(x => x.BodyColour)
                .Must(colour => colour is null || HexTriple.IsMatch(colour))
                .WithMessage("'{PropertyValue}' is not a #rrggbb colour.");

            // An id the server minted is 32 characters; anything far past that is not one of ours.
            rule.RuleFor(x => x.ProfileId).MaximumLength(64);
        });
    }

    // Blank and absent are one owner: every broker.
    private static string Owner(ColourRuleDto rule) =>
        string.IsNullOrWhiteSpace(rule.ProfileId) ? "" : rule.ProfileId;
}
