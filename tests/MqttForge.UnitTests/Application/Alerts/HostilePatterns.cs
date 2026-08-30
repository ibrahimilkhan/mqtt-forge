namespace MqttForge.UnitTests.Application.Alerts;

/// <summary>The one pattern in this plan that really does run away, and the one body it runs on.</summary>
// Shared rather than repeated because "catastrophic" is not a property of the pattern by itself.
// '(a+)+$' is the textbook example and RegexOptions.NonBacktracking takes it happily, answering in
// linear time — which is exactly what NonBacktracking is for, and which means a test using it would
// pass while proving nothing. What is needed is a pattern that combines a backtracking shape with a
// construct NonBacktracking refuses, so that CompiledPatterns.Compile falls back to the ordinary
// engine and its 50ms ceiling. The lookbehind is that construct: it forces the fallback and it
// changes nothing about the match.
//
// The body ends in a byte that cannot match. Only failure backtracks: against 4000 'a's alone the
// pattern succeeds immediately and nothing runs away at all.
internal static class HostilePatterns
{
    public const string Catastrophic = @"^(a+)+$(?<!z)";

    /// 4 kB, the spec's ceiling on the text a pattern is shown.
    public static readonly string Payload = new string('a', 4000) + "b";
}
