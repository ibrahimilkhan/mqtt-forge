using MQFaker.Domain.Models;

namespace MQFaker.Domain.Abstractions;

public interface IMqttPublisher
{
    Task PublishAsync(PublishRequest request, CancellationToken ct);
}
