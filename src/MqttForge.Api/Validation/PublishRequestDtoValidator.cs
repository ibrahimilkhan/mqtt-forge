using FluentValidation;
using MqttForge.Api.Contracts;

namespace MqttForge.Api.Validation;

public sealed class PublishRequestDtoValidator : AbstractValidator<PublishRequestDto>
{
    public PublishRequestDtoValidator()
    {
        RuleFor(x => x.Topic).NotEmpty();
        RuleFor(x => x.Qos).InclusiveBetween(0, 2);
    }
}
