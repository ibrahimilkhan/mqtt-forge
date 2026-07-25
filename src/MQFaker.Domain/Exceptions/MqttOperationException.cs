namespace MQFaker.Domain.Exceptions;

// MQTT işlemlerinin bilinen hata durumları; Infrastructure kütüphaneye özgü
// istisnaları bunlara çevirir, Api de bunları HTTP durumlarına eşler.
public abstract class MqttOperationException : Exception
{
    protected MqttOperationException(string message, Exception? inner = null)
        : base(message, inner) { }
}

// Broker'a ulaşılamadı, bağlantı reddedildi veya kimlik doğrulama başarısız
public sealed class BrokerUnreachableException : MqttOperationException
{
    public BrokerUnreachableException(string message, Exception? inner = null)
        : base(message, inner) { }
}

// İşlem aktif bir bağlantı gerektiriyor ama bağlantı yok
public sealed class NotConnectedException : MqttOperationException
{
    public NotConnectedException(string message, Exception? inner = null)
        : base(message, inner) { }
}
