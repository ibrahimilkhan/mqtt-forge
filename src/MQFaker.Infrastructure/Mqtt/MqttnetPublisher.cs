using MQFaker.Domain.Abstractions;
using MQFaker.Domain.Models;
using MQTTnet;
using MQTTnet.Protocol;

namespace MQFaker.Infrastructure.Mqtt;

public sealed class MqttnetPublisher : IMqttPublisher
{
    private readonly IMqttClient _client;

    public MqttnetPublisher(MqttnetClientProvider provider) => _client = provider.Client;

    public async Task PublishAsync(PublishRequest request, CancellationToken ct)
    {
        var message = new MqttApplicationMessageBuilder()
            .WithTopic(request.Topic)
            .WithPayload(request.Payload)
            .WithQualityOfServiceLevel((MqttQualityOfServiceLevel)request.Qos)
            .WithRetainFlag(request.Retain)
            .Build();

        await _client.PublishAsync(message, ct);
    }
}
