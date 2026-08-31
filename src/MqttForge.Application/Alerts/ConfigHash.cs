using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Alerts;

/// <summary>
/// A fingerprint of everything about a rule that decides when it fires: Filter, Field,
/// Condition, Clear and For. Saving compares it against the one the engine is holding, and the
/// answer decides whether a running rule keeps its window, its cooldown and its live alert or
/// starts again from nothing.
///
/// Name, Severity, Cooldown and Actions are deliberately outside it. Renaming a rule, softening
/// it from critical to warn, or ticking the sound box changes how an alert reads and where it
/// goes, not whether it happens — and a user who edits the wording of an alarm that is currently
/// ringing should not be silently ending it. Enabled is outside it too, for a different reason:
/// switching a rule off has its own outcome and its own resolvedBy string, and folding it in
/// here would report that as "rule changed".
/// </summary>
public static class ConfigHash
{
    // A byte no MQTT filter, no JSON path and no regular expression carries. Without a separator
    // between fields, filter "plant/a" with field "b" and filter "plant/ab" with no field are the
    // same run of characters, and those are two rules that read entirely different messages.
    private const char Separator = '\u001f';

    public static string Of(AlertRule rule)
    {
        var canonical = new StringBuilder();

        canonical.Append(rule.Filter).Append(Separator);
        canonical.Append(rule.Field ?? string.Empty).Append(Separator);
        Append(canonical, rule.Condition);
        canonical.Append(Separator);
        Append(canonical, rule.Clear);
        canonical.Append(Separator);
        canonical.Append(rule.For?.ToString(CultureInfo.InvariantCulture) ?? string.Empty);

        // SHA-256 rather than string.GetHashCode, and this is not caution for its own sake:
        // GetHashCode is randomised per process, and this value is written into
        // alert-state.json and read back after a restart. A randomised hash would make every
        // restored alert resolve as "rule changed" on every single start — which is the exact
        // failure the state file exists to prevent.
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(canonical.ToString())));
    }

    /// <summary>
    /// Walks the condition tree by hand. The obvious shortcut — a record's own ToString, which
    /// prints every property — is wrong for exactly the conditions that matter: `all` and `any`
    /// hold a list, and a record prints a list as its type name, so every composite rule in the
    /// file would hash the same as every other.
    /// </summary>
    private static void Append(StringBuilder text, AlertCondition? condition)
    {
        switch (condition)
        {
            case null:
                // A missing Clear is a real setting — it means "clear when the fire condition
                // stops being true" — so it needs a spelling of its own rather than an absence.
                text.Append("none");
                break;

            case ThresholdCondition threshold:
                text.Append("threshold(").Append(threshold.Op.ToString()).Append(',')
                    .Append(Number(threshold.Value)).Append(')');
                break;

            case BandCondition band:
                text.Append("band(").Append(Number(band.Low)).Append(',')
                    .Append(Number(band.High)).Append(',').Append(band.Inside).Append(')');
                break;

            case PatternCondition pattern:
                text.Append("pattern(");
                AppendCounted(text, pattern.Regex);
                text.Append(',').Append(pattern.Negate).Append(')');
                break;

            case OneOfCondition oneOf:
                text.Append("oneOf(");
                foreach (var value in oneOf.Values)
                {
                    AppendCounted(text, value);
                    text.Append(',');
                }

                text.Append(oneOf.Negate).Append(')');
                break;

            case AllCondition all:
                text.Append("all(");
                foreach (var of in all.Of)
                {
                    Append(text, of);
                    text.Append(',');
                }

                text.Append(')');
                break;

            case AnyCondition any:
                // The arms are taken in the order they are given, not sorted. `any` and `all`
                // short-circuit, so their order is the order the work is done in — and one arm
                // may be a pattern costing fifty milliseconds. Reordering is a real edit; the
                // price of treating it as one is a window the rule refills in seconds.
                text.Append("any(");
                foreach (var of in any.Of)
                {
                    Append(text, of);
                    text.Append(',');
                }

                text.Append(')');
                break;

            case SilenceCondition silence:
                text.Append("silence(")
                    .Append(silence.After.ToString(CultureInfo.InvariantCulture)).Append(')');
                break;

            case OutlierCondition outlier:
                // An arm of its own rather than the default's ToString, for the culture. A
                // record prints a double with the current culture's separator, so the same rule
                // would fingerprint as "K = 1.5" here and "K = 1,5" on a Turkish machine — and
                // this value is written into alert-state.json and read back after a restart,
                // where a fingerprint that moved reads as "rule changed" and quietly ends every
                // alarm the file was carrying. Number() is invariant, which is why it exists.
                text.Append("outlier(").Append(outlier.Method.ToString()).Append(',')
                    .Append(Number(outlier.K)).Append(',')
                    .Append(outlier.Window.ToString(CultureInfo.InvariantCulture)).Append(')');
                break;

            default:
                // For condition types added to the union after this switch was written — the
                // statistical family is the one heading this way. Falling back to the record's
                // own ToString is imperfect for a type that holds a list, but it is far better
                // than a constant: two different unknown conditions must never hash alike, or a
                // save would keep the state of a rule it no longer describes.
                text.Append(condition.GetType().Name).Append('(');
                AppendCounted(text, condition.ToString() ?? string.Empty);
                text.Append(')');
                break;
        }
    }

    // Length-prefixed, so that a list of two values cannot spell the same thing as one value
    // that happens to contain the separator: oneOf ["on", "off"] and oneOf ["on,off"] are
    // different rules and must read as different.
    private static void AppendCounted(StringBuilder text, string value) =>
        text.Append(value.Length.ToString(CultureInfo.InvariantCulture)).Append(':').Append(value);

    // "R" and not the default: 0.1 + 0.2 is not 0.3, but both print as "0.3" at fifteen digits,
    // and a threshold the user really did move would go on being judged by the old one.
    private static string Number(double value) => value.ToString("R", CultureInfo.InvariantCulture);
}
