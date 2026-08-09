using MqttForge.Domain.Models;

namespace MqttForge.Domain.Abstractions;

public interface IMqttPublisher
{
    Task PublishAsync(PublishRequest request, CancellationToken ct);
}
