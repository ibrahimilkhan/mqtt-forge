using System.Text.RegularExpressions;

namespace MqttForge.Application.Flows.Next;

/// <summary>What a variable may be called, written down once for the compiler, the templates and the values.</summary>
// A program's rule — a letter or an underscore, then letters, digits and underscores — because the
// people this is for name variables the way they name them in code, and a name with a dot or a dash
// in it could not be told from a path inside {{…}}.
public static partial class FlowVariables
{
    /// <summary>What marks a variable where a field could be written: <c>var.limit</c>, <c>{{var.limit}}</c>.</summary>
    public const string Prefix = "var.";

    public static bool IsName(string name) => NamePattern().IsMatch(name);

    // \z where the rule is written with $: in .NET a $ also matches in front of a final line break, so
    // "limit\n" would pass as a name that nothing could ever refer to, since a reference is trimmed
    // before it is read.
    [GeneratedRegex("^[A-Za-z_][A-Za-z0-9_]{0,39}\\z", RegexOptions.CultureInvariant)]
    private static partial Regex NamePattern();
}
