using FluentValidation;
using MqttForge.Api.Contracts;

namespace MqttForge.Api.Validation;

public sealed class SubscribeRequestDtoValidator : AbstractValidator<SubscribeRequestDto>
{
    public SubscribeRequestDtoValidator()
    {
        RuleFor(x => x.TopicFilter).NotEmpty();
        RuleFor(x => x.Qos).InclusiveBetween(0, 2);
    }
}
