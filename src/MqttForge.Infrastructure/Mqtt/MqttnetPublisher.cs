using System.Text;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;
using MQTTnet;
using MQTTnet.Exceptions;
using MQTTnet.Formatter;
using MQTTnet.Protocol;

namespace MqttForge.Infrastructure.Mqtt;

public sealed class MqttnetPublisher : IMqttPublisher
{
    private readonly IMqttClient _client;

    public MqttnetPublisher(MqttnetClientProvider provider) => _client = provider.Client;

    /// <summary>Which MQTT the live link settled on, which is not always the one asked for.</summary>
    // 'auto' walks 5.0 down to 3.1.1 on a broker that refuses the first, so the options the
    // console was opened with are not the answer — the client's own are.
    private MqttProtocolVersion Speaking() => _client.Options?.ProtocolVersion ?? MqttProtocolVersion.Unknown;

    public async Task PublishAsync(PublishRequest request, CancellationToken ct)
    {
        if (!_client.IsConnected)
            throw new NotConnectedException("Connect to a broker before publishing.");

        var builder = new MqttApplicationMessageBuilder()
            .WithTopic(request.Topic)
            .WithPayload(request.Payload)
            .WithQualityOfServiceLevel((MqttQualityOfServiceLevel)request.Qos)
            .WithRetainFlag(request.Retain);

        if (request.Properties is { Any: true } properties)
        {
            // Refused rather than dropped. 3.1.1 has no room for any of this, and a message that
            // went out without the correlation id it was given is a request whose reply the reader
            // will sit and wait for. The console only offers these on a 5.0 link; this is the
            // answer for anything else asking — a second console, or a script against the API.
            if (Speaking() != MqttProtocolVersion.V500)
                throw new MessageRejectedException(
                    "Content type, response topic, correlation data, expiry and user properties need MQTT 5. "
                    + "This link is speaking 3.1.1.");

            if (properties.ContentType is { } type) builder.WithContentType(type);
            if (properties.ResponseTopic is { } reply) builder.WithResponseTopic(reply);
            if (properties.CorrelationData is { } correlation) builder.WithCorrelationData(correlation);
            if (properties.MessageExpiryInterval is { } expiry) builder.WithMessageExpiryInterval(expiry);

            // The string overload is obsolete in MQTTnet 5; the value goes on the wire as bytes and
            // this is the encoding the specification names for it.
            foreach (var one in properties.UserProperties ?? [])
                builder.WithUserProperty(one.Name, Encoding.UTF8.GetBytes(one.Value));
        }

        var message = builder.Build();

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
