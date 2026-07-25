using MQFaker.Domain.Abstractions;
using MQFaker.Domain.Models;

namespace MQFaker.Application.Services;

public sealed class PublishService
{
    private readonly IMqttPublisher _publisher;

    public PublishService(IMqttPublisher publisher) => _publisher = publisher;

    public Task PublishAsync(PublishRequest request, CancellationToken ct) =>
        _publisher.PublishAsync(request, ct);
}
