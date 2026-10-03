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

    /// <summary>Compiles one rule's pattern the way every caller that holds a rule must compile it.</summary>
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
            return Ordinary(pattern);
        }
    }

    /// <summary>The ordinary engine with the 50 ms match timeout, for every pattern: how a flow compiles its patterns.</summary>
    // A rule's pattern is held to 250 characters and is shown 4 kB of text. A flow has more room: typed into a
    // node a pattern is up to 1,024 characters, read from a variable it is up to the variable's 64 KB, and what
    // it is shown may be 64 KB as well. A counted loop is as long to the linear engine as its count, so
    // 'a{9000}.*z' is ten characters and nine thousand to it, and one match of that against 64 KB took it four
    // seconds and more on the pump every flow shares, with no error to say so, from a Test that needs no save.
    // A flow's pattern needs a bound, and the bound has to be a sound one.
    //
    // The linear engine with a timeout is not one, on .NET 10.0.10, and both ways it fails were measured. Its
    // 50 ms is a ceiling and not a stop: it fires when the engine next looks at the clock, and
    // 'b{11}(?:c(?:z{3})?[ab]*|(?:[ab]{4,20}..)*[ab])+$', 48 characters, took three to five seconds to give up
    // over 47,671 random 'a's and 'b's, where it answers in seven with no timeout. And with a timeout set it
    // answers no where the answer is yes: '.*a[ab]{120}z' over random texts of 'a's and 'b's ending in a 'z'
    // is answered right at 1,000 characters, and from 2,000 up the engine said no to every text that the
    // ordinary engine, and the linear one without a timeout, say yes to, with a timeout of ten minutes as
    // well, which it was nowhere near. .NET 8.0.6 says yes to them with a timeout as without. For a flow a
    // wrong answer that says nothing is worse than a timeout that the node reports.
    //
    // So a flow takes the ordinary engine. It checks its timeout as it steps, so the 50 ms is a stop and not a
    // ceiling: the runaway shapes measured, among them 'a{9000}.*z' over 64 KB, which takes it fifteen seconds
    // with no timeout, all ended at 49 to 54 ms. And what it answers is the right answer. What it costs is the
    // guarantee: '(a+)+$' over four thousand 'a's and a 'b' was a no in milliseconds on the linear engine and
    // is a timeout on this one. The runtime turns the RegexMatchTimeoutException into an error on the node and
    // a "no", and ends the run's turn.
    //
    // A rule keeps Compile as it was: the linear engine with no timeout, and the ordinary one only for what
    // the linear engine refuses. A rule's pattern is held to 250 characters and its text to 4 kB, which keeps
    // what the linear engine has to do small for the patterns a person writes. The cap bounds what a pattern
    // says and not what it expands to, though, and that cost is known and is not changed here: a rule
    // 'a{4000}.*z' took about a second to match 4 kB of 'a's, and the alert pump pays that for each message.
    public static Regex CompileTimed(string pattern) => Ordinary(pattern);

    // The one place the ordinary engine and its ceiling are built: for every pattern of a flow, and for the
    // ones of a rule that the linear engine refuses.
    private static Regex Ordinary(string pattern) => new(pattern, RegexOptions.None, MatchTimeout);

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
