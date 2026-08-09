using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;
using MQTTnet;
using MQTTnet.Exceptions;
using MQTTnet.Protocol;

namespace MqttForge.Infrastructure.Mqtt;

public sealed class MqttnetPublisher : IMqttPublisher
{
    private readonly IMqttClient _client;

    public MqttnetPublisher(MqttnetClientProvider provider) => _client = provider.Client;

    public async Task PublishAsync(PublishRequest request, CancellationToken ct)
    {
        if (!_client.IsConnected)
            throw new NotConnectedException("Connect to a broker before publishing.");

        var message = new MqttApplicationMessageBuilder()
            .WithTopic(request.Topic)
            .WithPayload(request.Payload)
            .WithQualityOfServiceLevel((MqttQualityOfServiceLevel)request.Qos)
            .WithRetainFlag(request.Retain)
            .Build();

        try
        {
            await _client.PublishAsync(message, ct);
        }
        catch (MqttProtocolViolationException ex)
        {
            throw new MessageRejectedException($"Could not publish to '{request.Topic}': {ex.Message}", ex);
        }
        catch (MqttClientUnexpectedDisconnectReceivedException ex)
            when (ex.ReasonCode == MqttDisconnectReasonCode.PacketTooLarge)
        {
            throw new MessageRejectedException($"The broker rejected the message to '{request.Topic}' as too large.", ex);
        }
    }
}
