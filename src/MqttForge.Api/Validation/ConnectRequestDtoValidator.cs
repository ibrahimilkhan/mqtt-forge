using FluentValidation;
using MqttForge.Api.Contracts;

namespace MqttForge.Api.Validation;

public sealed class ConnectRequestDtoValidator : AbstractValidator<ConnectRequestDto>
{
    public ConnectRequestDtoValidator()
    {
        RuleFor(x => x.Host).NotEmpty();
        RuleFor(x => x.Port).InclusiveBetween(1, 65535);
        RuleFor(x => x.ClientId).NotEmpty();
    }
}
