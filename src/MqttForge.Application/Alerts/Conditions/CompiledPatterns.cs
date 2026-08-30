using System.Text.RegularExpressions;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Alerts.Conditions;

/// <summary>
/// Every <see cref="PatternCondition"/> in a rule set, compiled once. NonBacktracking first; falls
/// back to a plain <see cref="Regex"/> with a 50ms match timeout when the pattern needs
/// backreferences or lookaround.
/// </summary>
// Two problems, one class.
//
// The first is cost: a Regex built per message is a Regex built fifty times a second per topic per
// rule, and the pattern text does not change between messages. So the whole set is walked once
// when the rules are loaded and never again on the message path — which is also why the indexer
// throws for a pattern it does not hold rather than compiling one. A fallback that quietly
// compiles would be exactly the per-message compilation this class exists to prevent, appearing
// only under the load that makes it expensive.
//
// The second is time: a pattern is user input running inside the pump, and a backtracking one can
// hold that thread for the rest of the process's life. RegexOptions.NonBacktracking is the .NET
// engine with a linear-time guarantee and it is tried first for exactly that reason. It refuses
// backreferences and lookaround with a NotSupportedException, and those patterns get the ordinary
// engine with a 50ms ceiling instead.
//
// Note which patterns end up where, because it is not the obvious split: '(a+)+$' is the textbook
// catastrophic pattern and NonBacktracking takes it happily, in linear time. It is the combination
// — a backtracking shape AND a construct NonBacktracking refuses, like '^(a+)+$(?<!z)' — that
// reaches the timed engine and needs the ceiling.
public sealed class CompiledPatterns
{
    // Long enough for any pattern a person would write against a 4kB body, short enough that a
    // rule hitting it repeatedly costs the tick budget rather than the connection. The engine
    // counts these and disables the rule after ten in a row: a motor that silently slows down is
    // worse than one that stops.
    private static readonly TimeSpan MatchTimeout = TimeSpan.FromMilliseconds(50);

    // Keyed by the pattern text and not by the condition, so a rule whose Clear negates its own
    // fire pattern compiles one Regex rather than two. Negate is a question about the answer, not
    // about the machine that produces it.
    private readonly Dictionary<string, Regex> _byPattern;

    private CompiledPatterns(Dictionary<string, Regex> byPattern) => _byPattern = byPattern;

    public static CompiledPatterns For(IReadOnlyList<AlertRule> rules)
    {
        var byPattern = new Dictionary<string, Regex>(StringComparer.Ordinal);

        foreach (var rule in rules)
        {
            Collect(rule.Condition, byPattern);
            if (rule.Clear is not null) Collect(rule.Clear, byPattern);
        }

        return new CompiledPatterns(byPattern);
    }

    /// <summary>Compiles one pattern the way every caller in this repo must compile it.</summary>
    // Public because two places compile patterns and they have to agree: the validator, so a rule
    // is refused at the moment the user can still fix it, and JsonAlertRuleStore, because a rule
    // arriving from disk never went through the validator. An unparseable pattern throws
    // RegexParseException out of here for both of them to catch.
    public static Regex Compile(string pattern)
    {
        try
        {
            return new Regex(pattern, RegexOptions.NonBacktracking);
        }
        catch (NotSupportedException)
        {
            return new Regex(pattern, RegexOptions.None, MatchTimeout);
        }
    }

    public Regex this[PatternCondition condition] =>
        _byPattern.TryGetValue(condition.Regex, out var regex)
            ? regex
            : throw new KeyNotFoundException(
                $"The pattern '{condition.Regex}' was not compiled with this rule set.");

    // Only the composites recurse. The window conditions carry no children and the value
    // conditions carry no pattern, so there is nothing under them to find.
    private static void Collect(AlertCondition condition, Dictionary<string, Regex> into)
    {
        switch (condition)
        {
            case PatternCondition pattern:
                // ContainsKey rather than TryAdd: TryAdd would build the Regex first and throw
                // the duplicate away, which is a compilation per repeat of a shared pattern.
                if (!into.ContainsKey(pattern.Regex)) into.Add(pattern.Regex, Compile(pattern.Regex));
                break;

            case AllCondition all:
                foreach (var child in all.Of) Collect(child, into);
                break;

            case AnyCondition any:
                foreach (var child in any.Of) Collect(child, into);
                break;
        }
    }
}
