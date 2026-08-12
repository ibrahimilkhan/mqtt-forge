using System.Buffers.Text;
using FluentValidation;
using MqttForge.Api.Contracts;

namespace MqttForge.Api.Validation;

public sealed class PublishRequestDtoValidator : AbstractValidator<PublishRequestDto>
{
    public PublishRequestDtoValidator()
    {
        RuleFor(x => x.Topic).NotEmpty();
        RuleFor(x => x.Payload).NotNull();
        RuleFor(x => x.Qos).InclusiveBetween(0, 2);

        RuleFor(x => x.PayloadEncoding)
            .Must(encoding => encoding is null
                or PublishRequestDto.TextEncoding
                or PublishRequestDto.Base64Encoding)
            .WithMessage(
                $"payloadEncoding must be '{PublishRequestDto.TextEncoding}' or '{PublishRequestDto.Base64Encoding}'.");

        // Decoding happens after validation, so an unparsable body has to be refused here —
        // otherwise it surfaces as a FormatException from the controller instead of a 400.
        RuleFor(x => x.Payload)
            .Must(payload => payload is not null && Base64.IsValid(payload.AsSpan()))
            .When(x => x.PayloadEncoding == PublishRequestDto.Base64Encoding)
            .WithMessage("payload must be valid base64.");
    }
}
