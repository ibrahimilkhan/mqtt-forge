using FluentValidation;
using MqttForge.Api.Contracts;
using MqttForge.Domain.Enums;

namespace MqttForge.Api.Validation;

public sealed class ConnectRequestDtoValidator : AbstractValidator<ConnectRequestDto>
{
    public ConnectRequestDtoValidator()
    {
        RuleFor(x => x.Host).NotEmpty();
        RuleFor(x => x.Port).InclusiveBetween(1, 65535);
        RuleFor(x => x.ClientId).NotEmpty();

        // Only what a broker could not tell us more usefully. A path with a space in it never
        // reaches a broker at all — ClientWebSocket refuses to build the request — so it is worth
        // stopping here; a path that is merely wrong is the broker's answer to give, and it gives
        // a better one than any guess made from this side.
        RuleFor(x => x.WebSocketPath)
            .Must(BeAUsablePath)
            .When(x => x.Transport == MqttTransport.WebSocket && !string.IsNullOrWhiteSpace(x.WebSocketPath))
            .WithMessage("Not a usable path — write it as /mqtt.");

        // Zero and 0xFFFFFFFF are both meaningful in MQTT 5 (no session, and a session that
        // never expires), so the whole range is allowed and nothing is checked but the version:
        // a 3.x CONNECT has nowhere to put this, and silently dropping it would leave a reader
        // believing they had asked for something.
        RuleFor(x => x.SessionExpiryInterval)
            .Null()
            .When(x => x.ProtocolVersion is MqttProtocolLevel.V310 or MqttProtocolLevel.V311)
            .WithMessage("Session expiry is an MQTT 5 field. On 3.1 and 3.1.1 use Clean session instead.");

        RuleFor(x => x.Tls!.AlpnProtocol)
            .MaximumLength(255)
            .When(x => x.Tls?.AlpnProtocol is { Length: > 0 });
    }

    // Reachable as a WebSocket URI once the host and port are put in front of it. Anything else
    // fails inside HttpClient with a message about a URI the reader never typed.
    private static bool BeAUsablePath(string? path) =>
        Uri.TryCreate($"ws://h{Normalised(path)}", UriKind.Absolute, out _);

    private static string Normalised(string? path) =>
        path!.StartsWith('/') ? path : "/" + path;
}
