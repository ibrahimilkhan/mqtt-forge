using System.Text.RegularExpressions;

namespace MqttForge.Api;

/// <summary>Which pages may show the console in a frame: its own, and the ones MqttForge:FrameAncestors names.</summary>
/// <remarks>
/// A page on another site that frames the console can lay a decoy over its buttons — Disconnect,
/// Inject, Delete flow, Clear history — and the reader's click lands on the console, whose
/// requests from inside the frame are its own page's and pass the origin guard. So every answer
/// says who may frame it, twice: Content-Security-Policy's frame-ancestors, which can name them,
/// and X-Frame-Options: SAMEORIGIN, which cannot and is there for a browser too old for the first.
/// A browser that knows frame-ancestors goes by it and not by X-Frame-Options, as the HTML standard
/// says, so a page named here may frame the console in any current browser, and an old one keeps
/// it to itself. The desktop window loads the console as its page, not in a frame, and is untouched.
/// </remarks>
public static class FrameAncestors
{
    /// <summary>
    /// The setting that names the pages, besides the console's own, that may frame it: for someone
    /// showing the console in a Home Assistant panel, say. Each as its origin, scheme and host and
    /// port, and several with a space or a comma between them.
    /// </summary>
    public const string Setting = "MqttForge:FrameAncestors";

    // A page, in the frame-ancestors grammar, with a host always: http or https if a scheme is
    // given, a host that is a name or an IPv4 address, or a wildcard below a domain, and a port and
    // a path if wanted. Nothing that names no host — '*', a scheme on its own — since either lets
    // every site frame the console, which is the one thing this is for; no keyword, since 'self' is
    // always there and 'none' would take it away; and nothing a browser would read as more policy.
    private static readonly Regex Page = new(
        @"^(?:https?://)?(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::(?:[0-9]{1,5}|\*))?(?:/[a-z0-9\-._~%!$&()*+=:@/]*)?$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));

    /// <summary>
    /// The Content-Security-Policy every answer carries: 'self', and each page the setting names.
    /// Throws, naming the setting, for anything in it that is not a page, so an app that would send
    /// something else does not start.
    /// </summary>
    public static string Policy(string? setting)
    {
        var sources = new List<string> { "'self'" };

        foreach (var source in (setting ?? "").Split([' ', ',', '\t'], StringSplitOptions.RemoveEmptyEntries))
        {
            if (source == "'self'") continue;

            if (!Page.IsMatch(source))
                throw new InvalidOperationException(
                    $"{Setting} names '{source}', which is not a page that may frame the console. Name each page by its " +
                    "origin — https://homeassistant.local:8123 — with a space or a comma between them.");

            if (!sources.Contains(source, StringComparer.OrdinalIgnoreCase)) sources.Add(source);
        }

        return "frame-ancestors " + string.Join(' ', sources);
    }
}
