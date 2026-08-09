using FluentValidation;
using MqttForge.Api.Contracts;

namespace MqttForge.Api.Validation;

public sealed class SubscribeBatchDtoValidator : AbstractValidator<SubscribeBatchDto>
{
    // Measured against test.mosquitto.org: 200 filters per packet still answers in one round
    // trip, and past that a refusal costs the whole batch rather than one filter.
    public const int MaxPerBatch = 200;

    public SubscribeBatchDtoValidator()
    {
        RuleFor(x => x.Filters).NotEmpty();
        RuleFor(x => x.Filters.Count).LessThanOrEqualTo(MaxPerBatch)
            .WithMessage($"A batch carries at most {MaxPerBatch} filters.");
        RuleForEach(x => x.Filters).SetValidator(new SubscribeRequestDtoValidator());
    }
}
