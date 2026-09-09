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

        // ---- what MQTT 5 lets a message carry ----
        //
        // Bounded rather than merely non-null, because every one of these goes on the wire in
        // front of the payload: a broker's maximum packet size is the reader's to spend on the
        // message, not on a content type somebody pasted a file into.

        RuleFor(x => x.ContentType)
            .MaximumLength(255)
            .Must(NoControls)
            .WithMessage("contentType cannot contain control characters.");

        // A topic name and not a filter: a reply is published to exactly one topic, and a broker
        // refuses a wildcard here — with a disconnect on some, which takes the console's link
        // down for a typo.
        RuleFor(x => x.ResponseTopic)
            .MaximumLength(TopicLimit)
            .Must(topic => topic is null || (TopicFilter.IsValid(topic) && !topic.AsSpan().ContainsAny('+', '#')))
            .WithMessage("responseTopic must be a topic name, without '+' or '#'.");

        RuleFor(x => x.CorrelationData).MaximumLength(1024);

        RuleForEach(x => x.UserProperties)
            .ChildRules(one =>
            {
                one.RuleFor(p => p.Name).NotEmpty().MaximumLength(255).Must(NoControls);
                one.RuleFor(p => p.Value).MaximumLength(1024);
            })
            .When(x => x.UserProperties is not null);

        RuleFor(x => x.UserProperties!.Count)
            .LessThanOrEqualTo(MostProperties)
            .When(x => x.UserProperties is not null)
            .WithMessage($"a message may carry at most {MostProperties} user properties.");
    }

    /// <summary>What a broker will take as a topic name before it stops being a name.</summary>
    private const int TopicLimit = 512;

    /// <summary>
    /// How many names and values one message may carry.
    ///
    /// The specification sets no limit and brokers differ, so this is the console's own: twenty is
    /// past anything a device sends and short of a form that has become a database.
    /// </summary>
    private const int MostProperties = 20;

    // A control character in a header is a header a broker may refuse and a log nobody can read.
    private static bool NoControls(string? value) =>
        value is null || !value.Any(char.IsControl);
}
