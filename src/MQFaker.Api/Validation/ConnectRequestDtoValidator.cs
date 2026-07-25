using FluentValidation;
using MQFaker.Api.Contracts;

namespace MQFaker.Api.Validation;

public sealed class ConnectRequestDtoValidator : AbstractValidator<ConnectRequestDto>
{
    public ConnectRequestDtoValidator()
    {
        RuleFor(x => x.Host).NotEmpty();
        RuleFor(x => x.Port).InclusiveBetween(1, 65535);
        RuleFor(x => x.ClientId).NotEmpty();
    }
}
