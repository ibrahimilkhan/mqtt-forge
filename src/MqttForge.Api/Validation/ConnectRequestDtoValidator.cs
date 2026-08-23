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

        // Nothing checks the WebSocket path, deliberately. There was a rule here that asked
        // Uri.TryCreate whether the path could be dialled, on the theory that a space or a
        // backslash would never reach a broker — and it turned out Uri accepts both and escapes
        // them, so the rule refused nothing and only looked like a guard. What actually happens
        // is that the request goes out escaped, the broker answers 404, and the console says the
        // upgrade was refused and that the path is usually why. That is a better answer than any
        // guess from this side, which is the rule the rest of this validator follows.

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
}
