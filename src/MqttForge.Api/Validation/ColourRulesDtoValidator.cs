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

        // Two rules on one filter cannot both win, and quietly dropping one leaves the user
        // unable to explain why the rule they typed does nothing.
        RuleFor(x => x.Rules)
            .Must(rules => rules.Select(rule => rule.Filter).Distinct(StringComparer.Ordinal).Count() == rules.Count)
            .When(x => x.Rules is not null)
            .WithMessage("Each topic filter can carry only one colour.");

        RuleForEach(x => x.Rules).ChildRules(rule =>
        {
            rule.RuleFor(x => x.Filter)
                .Must(TopicFilter.IsValid)
                .WithMessage("'{PropertyValue}' is not a valid topic filter.");

            rule.RuleFor(x => x.Colour)
                .Must(colour => colour is not null && HexTriple.IsMatch(colour))
                .WithMessage("'{PropertyValue}' is not a #rrggbb colour.");
        });
    }
}
